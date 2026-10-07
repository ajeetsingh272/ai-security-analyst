package reduction

import (
	"context"
	"fmt"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/ajeetsingh272/ai-security-analyst/services/correlate/internal/scoring"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Store is the Postgres+ClickHouse-aware shell around Ratio's own pure
// math: ComputeDaily reads the day's signal and escalated-case counts
// from Postgres (where cluster.PostgresStore already writes them),
// computes the ratio, and persists it to ClickHouse's own
// sentinel.daily_reduction (P1-06) for backfill/trend-analysis
// querying (AC4). The live alert (AC2) and dashboard (AC3) both read a
// Prometheus gauge instead — see cmd/correlate/main.go's own export —
// not this stored ClickHouse row, which this ticket treats purely as
// the queryable historical record.
type Store struct {
	pg *pgxpool.Pool
	ch driver.Conn
}

func NewStore(pg *pgxpool.Pool, ch driver.Conn) *Store {
	return &Store{pg: pg, ch: ch}
}

// DailyResult is one tenant's one day's own measurement.
type DailyResult struct {
	TenantID       string
	Day            time.Time
	Signals        uint64
	CasesEscalated uint64
	Ratio          float64
	// OK mirrors Ratio's own "zero signals" case — false means Signals
	// was 0, Ratio is meaningless, and callers must not alert on it.
	OK bool
}

// ComputeDaily measures tenantID's own reduction ratio for day
// (truncated to a calendar date) and stores it. Safe to call more than
// once for the same (tenantID, day) — a backfill rerun, or today's
// job running again after a retry — because it deletes any existing
// ClickHouse row for that key before inserting the freshly computed
// one: sentinel.daily_reduction is a SummingMergeTree, which would
// silently DOUBLE the stored signals/cases_escalated counts (not just
// overwrite them) if the same day were ever inserted twice without
// that delete.
func (s *Store) ComputeDaily(ctx context.Context, tenantID string, day time.Time) (DailyResult, error) {
	day = day.UTC().Truncate(24 * time.Hour)

	var plan string
	if err := s.pg.QueryRow(ctx, `SELECT plan FROM tenants WHERE id = $1`, tenantID).Scan(&plan); err != nil {
		return DailyResult{}, fmt.Errorf("reduction: reading plan for tenant %s: %w", tenantID, err)
	}
	threshold := scoring.EscalationThreshold(scoring.PlanTier(plan))

	result, err := sentineldb.WithTenantContext(ctx, s.pg, tenantID, func(ctx context.Context, tx pgx.Tx) (DailyResult, error) {
		var signals uint64
		if err := tx.QueryRow(ctx,
			`SELECT count(*) FROM case_signals WHERE tenant_id = $1 AND detected_at >= $2 AND detected_at < $2 + INTERVAL '1 day'`,
			tenantID, day,
		).Scan(&signals); err != nil {
			return DailyResult{}, err
		}

		var casesEscalated uint64
		if err := tx.QueryRow(ctx,
			`SELECT count(*) FROM cases WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $2 + INTERVAL '1 day' AND score >= $3`,
			tenantID, day, threshold,
		).Scan(&casesEscalated); err != nil {
			return DailyResult{}, err
		}

		ratio, ok := Ratio(signals, casesEscalated)
		return DailyResult{TenantID: tenantID, Day: day, Signals: signals, CasesEscalated: casesEscalated, Ratio: ratio, OK: ok}, nil
	})
	if err != nil {
		return DailyResult{}, fmt.Errorf("reduction: counting signals/cases for tenant %s on %s: %w", tenantID, day.Format("2006-01-02"), err)
	}

	if err := s.storeClickHouse(ctx, result); err != nil {
		return DailyResult{}, fmt.Errorf("reduction: storing daily_reduction row for tenant %s on %s: %w", tenantID, day.Format("2006-01-02"), err)
	}
	return result, nil
}

func (s *Store) storeClickHouse(ctx context.Context, r DailyResult) error {
	// mutations_sync=1: a lightweight-delete mutation is ASYNCHRONOUS
	// by default — without this, the DELETE below returns before the
	// old row is actually gone, and a rerun's INSERT can land first,
	// letting SummingMergeTree sum the old and new counts together
	// instead of replacing them. Confirmed directly: the rerun-
	// idempotency test below failed intermittently without this,
	// exactly from that race.
	syncCtx := clickhouse.Context(ctx, clickhouse.WithSettings(clickhouse.Settings{"mutations_sync": "1"}))
	if err := s.ch.Exec(syncCtx,
		`ALTER TABLE sentinel.daily_reduction DELETE WHERE tenant_id = ? AND day = ?`,
		r.TenantID, r.Day,
	); err != nil {
		return fmt.Errorf("deleting any existing row: %w", err)
	}
	return s.ch.Exec(ctx,
		`INSERT INTO sentinel.daily_reduction (tenant_id, day, signals, cases_escalated, ratio) VALUES (?, ?, ?, ?, ?)`,
		r.TenantID, r.Day, r.Signals, r.CasesEscalated, float32(r.Ratio),
	)
}

// AllTenantIDs lists every tenant — the same cross-tenant sweep shape
// cmd/correlate's own runQuietPeriodSweep/runBaselineRecomputeSweep
// already use.
func (s *Store) AllTenantIDs(ctx context.Context) ([]string, error) {
	rows, err := s.pg.Query(ctx, `SELECT id FROM tenants`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
