//go:build integration

package reduction

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/ajeetsingh272/ai-security-analyst/services/correlate/internal/scoring"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func newTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := sentineldb.NewPool(context.Background())
	if err != nil {
		t.Fatalf("connecting to postgres: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func newTestClickHouse(t *testing.T) driver.Conn {
	t.Helper()
	conn, err := clickhouse.Open(&clickhouse.Options{
		Addr: []string{envOr("CLICKHOUSE_ADDR", "localhost:9000")},
		Auth: clickhouse.Auth{
			Database: envOr("CLICKHOUSE_DATABASE", "sentinel"),
			Username: envOr("CLICKHOUSE_USER", "default"),
			Password: envOr("CLICKHOUSE_PASSWORD", ""),
		},
	})
	if err != nil {
		t.Fatalf("connecting to clickhouse: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func createTenant(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var tenantID string
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO tenants (name, plan) VALUES ($1, 'trial') RETURNING id`,
		"reduction probe "+time.Now().Format("20060102150405.000000000"),
	).Scan(&tenantID); err != nil {
		t.Fatalf("creating tenant fixture: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, tenantID)
	})
	return tenantID
}

// seedCase inserts one bare cases row (with the given score, already
// computed — this package tests its OWN counting SQL, not scoring or
// clustering, both covered by their own packages' tests) plus
// signalCount case_signals rows, all dated within day.
func seedCase(t *testing.T, pool *pgxpool.Pool, tenantID string, day time.Time, score float64, signalCount int) {
	t.Helper()
	_, err := sentineldb.WithTenantContext(context.Background(), pool, tenantID, func(ctx context.Context, tx pgx.Tx) (struct{}, error) {
		var caseID string
		if err := tx.QueryRow(ctx,
			`INSERT INTO cases (tenant_id, severity, title, window_start, score, signal_count, created_at)
			 VALUES ($1, 'medium', 'reduction-test case', $2, $3, $4, $2) RETURNING id`,
			tenantID, day.Add(time.Hour), score, signalCount,
		).Scan(&caseID); err != nil {
			return struct{}{}, err
		}
		for i := 0; i < signalCount; i++ {
			dedupeKey := fmt.Sprintf("%s-sig-%d", caseID, i)
			if _, err := tx.Exec(ctx,
				`INSERT INTO case_signals (tenant_id, case_id, dedupe_key, signal_id, rule_id, entity_type, entity_id, severity, event_ids, detected_at)
				 VALUES ($1, $2, $3, $4, 'reduction-test-rule', 'user', 'probe-user', 'medium', '{}', $5)`,
				tenantID, caseID, dedupeKey, dedupeKey, day.Add(time.Hour+time.Duration(i)*time.Minute),
			); err != nil {
				return struct{}{}, err
			}
		}
		return struct{}{}, nil
	})
	if err != nil {
		t.Fatalf("seeding case: %v", err)
	}
}

// T1: the ratio is computed correctly from a seeded signal and case
// set — 3 cases above threshold (escalated), 2 below, with a known
// total signal count.
func TestStore_ComputeDaily_ComputesRatioFromSeededSignalsAndCases(t *testing.T) {
	pool := newTestPool(t)
	ch := newTestClickHouse(t)
	tenantID := createTenant(t, pool)
	store := NewStore(pool, ch)
	day := time.Now().UTC().Truncate(24 * time.Hour)

	threshold := scoringThresholdFor(t, pool, tenantID)
	seedCase(t, pool, tenantID, day, threshold+10, 4) // escalated
	seedCase(t, pool, tenantID, day, threshold+5, 3)  // escalated
	seedCase(t, pool, tenantID, day, threshold+1, 2)  // escalated
	seedCase(t, pool, tenantID, day, threshold-5, 5)  // not escalated
	seedCase(t, pool, tenantID, day, threshold-1, 6)  // not escalated

	result, err := store.ComputeDaily(context.Background(), tenantID, day)
	if err != nil {
		t.Fatalf("ComputeDaily: %v", err)
	}
	if !result.OK {
		t.Fatal("expected OK=true for a non-zero signal day")
	}
	if result.Signals != 20 { // 4+3+2+5+6
		t.Errorf("got Signals=%d, want 20", result.Signals)
	}
	if result.CasesEscalated != 3 {
		t.Errorf("got CasesEscalated=%d, want 3", result.CasesEscalated)
	}
	wantRatio := 20.0 / 3.0
	if result.Ratio != wantRatio {
		t.Errorf("got Ratio=%v, want %v", result.Ratio, wantRatio)
	}
}

// T2: a deliberately noisy rule (every case escalates, reduction
// barely happens) drives the ratio below the 8:1 floor.
func TestStore_ComputeDaily_NoisyRuleDrivesRatioBelowThreshold(t *testing.T) {
	pool := newTestPool(t)
	ch := newTestClickHouse(t)
	tenantID := createTenant(t, pool)
	store := NewStore(pool, ch)
	day := time.Now().UTC().Truncate(24 * time.Hour)

	threshold := scoringThresholdFor(t, pool, tenantID)
	// 10 signals, EVERY one of them its own escalated case — a 1:1
	// ratio, the noisiest possible rule behaviour.
	for i := 0; i < 10; i++ {
		seedCase(t, pool, tenantID, day, threshold+1, 1)
	}

	result, err := store.ComputeDaily(context.Background(), tenantID, day)
	if err != nil {
		t.Fatalf("ComputeDaily: %v", err)
	}
	if !result.OK {
		t.Fatal("expected OK=true")
	}
	if result.Ratio >= 8 {
		t.Fatalf("got Ratio=%v, want below the 8:1 alert floor for this deliberately noisy fixture", result.Ratio)
	}

	// The stored ClickHouse row is the backfillable historical record
	// (AC4) — confirm it actually landed with the same numbers.
	var signals, casesEscalated uint64
	var ratio float32
	if err := ch.QueryRow(context.Background(),
		`SELECT signals, cases_escalated, ratio FROM sentinel.daily_reduction WHERE tenant_id = ? AND day = ?`,
		tenantID, day,
	).Scan(&signals, &casesEscalated, &ratio); err != nil {
		t.Fatalf("reading back daily_reduction: %v", err)
	}
	if signals != result.Signals || casesEscalated != result.CasesEscalated {
		t.Errorf("stored ClickHouse row (signals=%d, cases_escalated=%d) does not match the computed result (%+v)", signals, casesEscalated, result)
	}
}

// Rerunning ComputeDaily for the same (tenant, day) — a backfill retry
// — must not double the stored counts (SummingMergeTree would, if the
// old row were not deleted first).
func TestStore_ComputeDaily_RerunDoesNotDoubleCount(t *testing.T) {
	pool := newTestPool(t)
	ch := newTestClickHouse(t)
	tenantID := createTenant(t, pool)
	store := NewStore(pool, ch)
	day := time.Now().UTC().Truncate(24 * time.Hour)
	threshold := scoringThresholdFor(t, pool, tenantID)
	seedCase(t, pool, tenantID, day, threshold+1, 7)

	ctx := context.Background()
	first, err := store.ComputeDaily(ctx, tenantID, day)
	if err != nil {
		t.Fatalf("first ComputeDaily: %v", err)
	}
	second, err := store.ComputeDaily(ctx, tenantID, day)
	if err != nil {
		t.Fatalf("second ComputeDaily (rerun): %v", err)
	}
	if first.Signals != second.Signals || first.CasesEscalated != second.CasesEscalated {
		t.Fatalf("rerun produced different in-Postgres counts: first=%+v second=%+v", first, second)
	}

	var stored uint64
	if err := ch.QueryRow(ctx,
		`SELECT sum(signals) FROM sentinel.daily_reduction WHERE tenant_id = ? AND day = ?`,
		tenantID, day,
	).Scan(&stored); err != nil {
		t.Fatalf("reading back daily_reduction: %v", err)
	}
	if stored != first.Signals {
		t.Errorf("stored signals=%d after a rerun, want %d (unchanged, not doubled)", stored, first.Signals)
	}

	t.Cleanup(func() {
		_ = ch.Exec(context.Background(), `ALTER TABLE sentinel.daily_reduction DELETE WHERE tenant_id = ?`, tenantID)
	})
}

func scoringThresholdFor(t *testing.T, pool *pgxpool.Pool, tenantID string) float64 {
	t.Helper()
	var plan string
	if err := pool.QueryRow(context.Background(), `SELECT plan FROM tenants WHERE id = $1`, tenantID).Scan(&plan); err != nil {
		t.Fatalf("reading tenant plan: %v", err)
	}
	return scoring.EscalationThreshold(scoring.PlanTier(plan))
}
