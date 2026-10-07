package baseline

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Store is the ClickHouse+Postgres-aware shell around baseline.go's
// own pure evaluation — GetBaseline (a read) and Recompute (an
// incremental write), mirroring internal/lifecycle's own pure-core/
// DB-shell split.
type Store struct {
	ch      driver.Conn
	cursors *pgxpool.Pool
}

func NewStore(ch driver.Conn, cursors *pgxpool.Pool) *Store {
	return &Store{ch: ch, cursors: cursors}
}

// GetBaseline reads entityID's own current baseline for metric, merged
// across Window days of already-recomputed state in
// sentinel.entity_baselines — this is the function a later phase's
// tool-calling layer wraps as get_entity_baseline(entity, metric).
func (s *Store) GetBaseline(ctx context.Context, tenantID, entityID string, metric Metric) (Baseline, error) {
	raw, err := s.readAggregate(ctx, tenantID, entityID, metric)
	if err != nil {
		return Baseline{}, fmt.Errorf("baseline: reading %s baseline for entity %s: %w", metric, entityID, err)
	}
	return evaluate(metric, raw), nil
}

func (s *Store) readAggregate(ctx context.Context, tenantID, entityID string, metric Metric) (rawAggregate, error) {
	if metric == MetricDataVolume {
		row := s.ch.QueryRow(ctx,
			`SELECT sum(finalizeAggregation(observations)), quantilesTDigestMerge(0.5, 0.95, 0.99)(volume_quantiles)
			 FROM sentinel.entity_baselines
			 WHERE tenant_id = ? AND entity_id = ? AND metric = ? AND bucket >= today() - ?`,
			tenantID, entityID, string(metric), Window,
		)
		var n uint64
		var quantiles []float64
		if err := row.Scan(&n, &quantiles); err != nil {
			return rawAggregate{}, err
		}
		return rawAggregate{Observations: n, Quantiles: quantiles}, nil
	}

	row := s.ch.QueryRow(ctx,
		`SELECT sum(finalizeAggregation(observations)), topKMerge(10)(value_counts)
		 FROM sentinel.entity_baselines
		 WHERE tenant_id = ? AND entity_id = ? AND metric = ? AND bucket >= today() - ?`,
		tenantID, entityID, string(metric), Window,
	)
	var n uint64
	var topValues []string
	if err := row.Scan(&n, &topValues); err != nil {
		return rawAggregate{}, err
	}
	return rawAggregate{Observations: n, TopValues: topValues}, nil
}

// categoricalMetric is one of the four metrics evaluate treats as a
// "usual values" list — everything except MetricDataVolume — paired
// with the sentinel.events column (or expression) Recompute aggregates
// to produce it.
type categoricalMetric struct {
	metric Metric
	expr   string // a sentinel.events column/expression, never user input
	filter string // an additional WHERE clause ANDed onto the base filter, or ""
}

var categoricalMetrics = []categoricalMetric{
	{metric: MetricCountry, expr: "src_country"},
	{metric: MetricASN, expr: "toString(src_asn)"},
	{metric: MetricDevice, expr: "device_uid"},
	// class_uid 3002 is OCSF's Authentication class
	// (go/sentinelconnector/ocsf) — sign-in hour distribution is only
	// meaningful over actual authentication events, not every event
	// this entity ever appears in.
	{metric: MetricSignInHour, expr: "toString(toHour(time))", filter: "AND class_uid = 3002"},
}

// Recompute folds every sentinel.events row for tenantID with
// time > the tenant's own stored watermark and <= asOf into
// sentinel.entity_baselines, one partial AggregatingMergeTree state
// per (entity, metric, day) — never a full rescan of the whole 30-day
// window (AC5): only the events since the last run are read or
// written. ClickHouse's own merge combinators (topKMerge, uniqMerge,
// quantilesTDigestMerge, ...) guarantee that N incremental partial
// states merge to the identical result a single pass over the same
// rows would have produced (T3) — there is no "catch up" step needed
// beyond advancing the watermark.
//
// Known limitation: the ClickHouse insert and the Postgres watermark
// advance are two separate writes, not one transaction (they are two
// different databases) — a crash between them makes the NEXT run
// re-process the same batch, double-counting it into those buckets.
// This is an accepted tradeoff for a behavioural baseline (a rare,
// small overcount in a 30-day statistical signal), not the kind of
// exactly-once guarantee a ledger like go/sentinelaudit needs.
func (s *Store) Recompute(ctx context.Context, tenantID string, asOf time.Time) error {
	since, err := s.watermark(ctx, tenantID)
	if err != nil {
		return fmt.Errorf("baseline: reading watermark for tenant %s: %w", tenantID, err)
	}
	if !since.Before(asOf) {
		return nil // nothing new since the last run
	}

	for _, cm := range categoricalMetrics {
		if err := s.recomputeCategorical(ctx, tenantID, cm, since, asOf); err != nil {
			return fmt.Errorf("baseline: recomputing %s for tenant %s: %w", cm.metric, tenantID, err)
		}
	}
	if err := s.recomputeDataVolume(ctx, tenantID, since, asOf); err != nil {
		return fmt.Errorf("baseline: recomputing %s for tenant %s: %w", MetricDataVolume, tenantID, err)
	}

	if err := s.advanceWatermark(ctx, tenantID, asOf); err != nil {
		return fmt.Errorf("baseline: advancing watermark for tenant %s: %w", tenantID, err)
	}
	return nil
}

func (s *Store) recomputeCategorical(ctx context.Context, tenantID string, cm categoricalMetric, since, asOf time.Time) error {
	return s.ch.Exec(ctx,
		`INSERT INTO sentinel.entity_baselines (tenant_id, entity_id, metric, bucket, observations, distinct_values, value_counts, volume_quantiles)
		 SELECT tenant_id, actor_user_uid, ?, toDate(time),
		        countState(), uniqState(`+cm.expr+`), topKState(10)(`+cm.expr+`),
		        quantilesTDigestStateIf(0.5, 0.95, 0.99)(0., 1 = 0)
		 FROM sentinel.events
		 WHERE tenant_id = ? AND actor_user_uid != '' AND time > ? AND time <= ? `+cm.filter+`
		 GROUP BY tenant_id, actor_user_uid, toDate(time)`,
		string(cm.metric), tenantID, since, asOf,
	)
}

func (s *Store) recomputeDataVolume(ctx context.Context, tenantID string, since, asOf time.Time) error {
	return s.ch.Exec(ctx,
		`INSERT INTO sentinel.entity_baselines (tenant_id, entity_id, metric, bucket, observations, distinct_values, value_counts, volume_quantiles)
		 SELECT tenant_id, actor_user_uid, ?, toDate(time),
		        countState(), uniqStateIf('', 1 = 0), topKStateIf(10)('', 1 = 0),
		        quantilesTDigestState(0.5, 0.95, 0.99)(toFloat64OrZero(metadata['bytes']))
		 FROM sentinel.events
		 WHERE tenant_id = ? AND actor_user_uid != '' AND has(metadata, 'bytes') AND time > ? AND time <= ?
		 GROUP BY tenant_id, actor_user_uid, toDate(time)`,
		string(MetricDataVolume), tenantID, since, asOf,
	)
}

// epoch is used as "no watermark yet" — the first Recompute for a
// tenant then folds in its ENTIRE existing event history (bounded
// anyway by sentinel.events' own 90-day hot retention), which is
// exactly right: there is no partial-baseline state to protect, only
// a full one to build for the first time.
var epoch = time.Unix(0, 0).UTC()

// watermark/advanceWatermark both go through sentineldb.WithTenantContext,
// the same RLS-enforcing path every other tenant-scoped write in this
// codebase uses (lifecycle.Writer, cluster.PostgresStore, scoring.Recompute)
// — baseline_cursors has the identical tenant_isolation policy those
// tables do, so a plain pool query here would silently see zero rows
// under any role that does not bypass RLS.
func (s *Store) watermark(ctx context.Context, tenantID string) (time.Time, error) {
	return sentineldb.WithTenantContext(ctx, s.cursors, tenantID, func(ctx context.Context, tx pgx.Tx) (time.Time, error) {
		var t time.Time
		err := tx.QueryRow(ctx, `SELECT last_processed_at FROM baseline_cursors WHERE tenant_id = $1`, tenantID).Scan(&t)
		if errors.Is(err, pgx.ErrNoRows) {
			return epoch, nil
		}
		return t, err
	})
}

func (s *Store) advanceWatermark(ctx context.Context, tenantID string, asOf time.Time) error {
	_, err := sentineldb.WithTenantContext(ctx, s.cursors, tenantID, func(ctx context.Context, tx pgx.Tx) (struct{}, error) {
		_, err := tx.Exec(ctx,
			`INSERT INTO baseline_cursors (tenant_id, last_processed_at, updated_at) VALUES ($1, $2, now())
			 ON CONFLICT (tenant_id) DO UPDATE SET last_processed_at = $2, updated_at = now()`,
			tenantID, asOf,
		)
		return struct{}{}, err
	})
	return err
}
