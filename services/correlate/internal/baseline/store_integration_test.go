//go:build integration

package baseline

import (
	"context"
	"fmt"
	"os"
	"sort"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
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
		"baseline probe "+time.Now().Format("20060102150405.000000000"),
	).Scan(&tenantID); err != nil {
		t.Fatalf("creating tenant fixture: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, tenantID)
	})
	return tenantID
}

// seedEvents inserts n synthetic Authentication events for entityID,
// spread across [start, start+spread), with everyNth landing in
// altCountry/altASN instead of the usual ones (T1's own "habitual vs
// occasional" shape) — and cleans itself up afterward, since
// sentinel.events has no tenant-scoped DELETE-on-cascade the way a
// Postgres fixture does.
func seedEvents(t *testing.T, ch driver.Conn, tenantID, entityID string, n int, start time.Time, everyNth int, altCountry string, altASN uint32, bytesBase, bytesStep int) {
	t.Helper()
	t.Cleanup(func() {
		_ = ch.Exec(context.Background(), `ALTER TABLE sentinel.events DELETE WHERE tenant_id = ?`, tenantID)
		_ = ch.Exec(context.Background(), `ALTER TABLE sentinel.entity_baselines DELETE WHERE tenant_id = ?`, tenantID)
	})

	// Sign-in hour is deliberately skewed (a tight 9-11 cluster, a rare
	// hour-23 outlier under the same everyNth knob the country/ASN
	// skew already uses) rather than spread near-uniformly across all
	// 24 hours — topK is an approximate sketch, and a near-uniform
	// distribution has no clear "top 10", which makes its exact
	// membership and order genuinely unstable across different merge
	// paths (a real property of the algorithm, confirmed by hitting it
	// directly: T3 failed here before this fix with a near-uniform
	// hour spread). A skewed distribution — the realistic shape for
	// actual sign-in behaviour anyway — has a clear, stable winner.
	err := ch.Exec(context.Background(),
		`INSERT INTO sentinel.events
		   (tenant_id, event_id, time, class_uid, category_uid, activity_id, type_uid, severity_id,
		    actor_user_uid, src_country, src_asn, device_uid, status_id, metadata)
		 SELECT
		   ?, concat(?, toString(number)),
		   ? + toIntervalHour(if(? > 0 AND number % ? = 0, 23, 9 + number % 3)) + toIntervalMinute(number),
		   3002, 3, 1, 300201, 1,
		   ?,
		   if(? > 0 AND number % ? = 0, ?, 'US'),
		   if(? > 0 AND number % ? = 0, toUInt32(?), toUInt32(701)),
		   'device-A', 1,
		   map('bytes', toString(? + number * ?))
		 FROM numbers(?)`,
		tenantID, entityID+"-", start,
		everyNth, maxInt(everyNth, 1),
		entityID,
		everyNth, maxInt(everyNth, 1), altCountry,
		everyNth, maxInt(everyNth, 1), altASN,
		bytesBase, bytesStep,
		n,
	)
	if err != nil {
		t.Fatalf("seeding events: %v", err)
	}
}

func sortedCopy(s []string) []string {
	out := append([]string{}, s...)
	sort.Strings(out)
	return out
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// T1 (real ClickHouse): a habitual sign-in country is correctly
// identified from seeded history.
func TestStore_RecomputeThenGetBaseline_IdentifiesHabitualCountry(t *testing.T) {
	pool := newTestPool(t)
	ch := newTestClickHouse(t)
	tenantID := createTenant(t, pool)
	store := NewStore(ch, pool)
	ctx := context.Background()

	start := time.Now().UTC().Add(-10 * 24 * time.Hour)
	seedEvents(t, ch, tenantID, "alice", 60, start, 20, "RU", 64512, 1000, 37)

	if err := store.Recompute(ctx, tenantID, time.Now().UTC()); err != nil {
		t.Fatalf("Recompute: %v", err)
	}

	b, err := store.GetBaseline(ctx, tenantID, "alice", MetricCountry)
	if err != nil {
		t.Fatalf("GetBaseline: %v", err)
	}
	if !b.Valid {
		t.Fatalf("expected a valid baseline, got %+v", b)
	}
	if !b.IsUsualValue("US") {
		t.Errorf("US is the habitual country (19/20 events) and should be usual; got %+v", b)
	}
	if b.IsAnomalous("US") {
		t.Error("US should not be anomalous")
	}
	if !b.IsAnomalous("DE") {
		t.Error("a country never seen in history should be anomalous")
	}
}

// T2 (real ClickHouse): an entity below the observation threshold
// returns insufficient-data.
func TestStore_GetBaseline_BelowThresholdIsInsufficientData(t *testing.T) {
	pool := newTestPool(t)
	ch := newTestClickHouse(t)
	tenantID := createTenant(t, pool)
	store := NewStore(ch, pool)
	ctx := context.Background()

	start := time.Now().UTC().Add(-2 * 24 * time.Hour)
	seedEvents(t, ch, tenantID, "new-hire", MinObservations-5, start, 0, "", 0, 0, 0)

	if err := store.Recompute(ctx, tenantID, time.Now().UTC()); err != nil {
		t.Fatalf("Recompute: %v", err)
	}

	b, err := store.GetBaseline(ctx, tenantID, "new-hire", MetricCountry)
	if err != nil {
		t.Fatalf("GetBaseline: %v", err)
	}
	if b.Valid {
		t.Fatalf("expected an invalid (insufficient-data) baseline below the observation threshold, got %+v", b)
	}
}

// T3 (real ClickHouse): incremental recomputation (two Recompute calls
// with an advancing watermark) matches a single full recomputation
// over the identical event set, for every metric.
func TestStore_IncrementalRecomputeMatchesFullRecompute(t *testing.T) {
	pool := newTestPool(t)
	ch := newTestClickHouse(t)
	ctx := context.Background()
	start := time.Now().UTC().Add(-10 * 24 * time.Hour)
	midpoint := start.Add(5 * 24 * time.Hour)
	end := time.Now().UTC()

	fullTenant := createTenant(t, pool)
	seedEvents(t, ch, fullTenant, "bob", 80, start, 20, "RU", 64512, 1000, 37)
	fullStore := NewStore(ch, pool)
	if err := fullStore.Recompute(ctx, fullTenant, end); err != nil {
		t.Fatalf("full Recompute: %v", err)
	}

	incrTenant := createTenant(t, pool)
	seedEvents(t, ch, incrTenant, "bob", 80, start, 20, "RU", 64512, 1000, 37)
	incrStore := NewStore(ch, pool)
	if err := incrStore.Recompute(ctx, incrTenant, midpoint); err != nil {
		t.Fatalf("incremental Recompute (first half): %v", err)
	}
	if err := incrStore.Recompute(ctx, incrTenant, end); err != nil {
		t.Fatalf("incremental Recompute (second half): %v", err)
	}

	for _, metric := range []Metric{MetricCountry, MetricASN, MetricDevice, MetricSignInHour, MetricDataVolume} {
		full, err := fullStore.GetBaseline(ctx, fullTenant, "bob", metric)
		if err != nil {
			t.Fatalf("GetBaseline(full, %s): %v", metric, err)
		}
		incr, err := incrStore.GetBaseline(ctx, incrTenant, "bob", metric)
		if err != nil {
			t.Fatalf("GetBaseline(incremental, %s): %v", metric, err)
		}
		if full.Observations != incr.Observations {
			t.Errorf("%s: full.Observations = %d, incremental.Observations = %d, want equal", metric, full.Observations, incr.Observations)
		}
		// Compared as SETS, not exact slice order: topK is an
		// approximate sketch, and two values tied on exact count have
		// no guaranteed stable relative order across different merge
		// paths — confirmed directly (this test failed on exact order
		// before this fix, over nothing but a tie). Set membership is
		// also all Baseline.IsUsualValue/IsAnomalous ever check, so
		// it's the only property that actually matters here.
		if fmt.Sprint(sortedCopy(full.UsualValues)) != fmt.Sprint(sortedCopy(incr.UsualValues)) {
			t.Errorf("%s: full.UsualValues = %v, incremental.UsualValues = %v, want the same set", metric, full.UsualValues, incr.UsualValues)
		}
		if (full.Volume == nil) != (incr.Volume == nil) {
			t.Errorf("%s: full.Volume = %v, incremental.Volume = %v", metric, full.Volume, incr.Volume)
		} else if full.Volume != nil && *full.Volume != *incr.Volume {
			t.Errorf("%s: full.Volume = %+v, incremental.Volume = %+v, want equal", metric, *full.Volume, *incr.Volume)
		}
	}
}

// T4 (real ClickHouse): a new employee's first week does not generate
// anomaly signals purely from novelty — every value is IsAnomalous ==
// false against an insufficient-history baseline, including values
// that would clearly be flagged once the baseline matures.
func TestStore_NewEntityFirstWeekNeverAnomalous(t *testing.T) {
	pool := newTestPool(t)
	ch := newTestClickHouse(t)
	tenantID := createTenant(t, pool)
	store := NewStore(ch, pool)
	ctx := context.Background()

	start := time.Now().UTC().Add(-6 * 24 * time.Hour)
	// A genuinely new hire: a handful of sign-ins this week, well under
	// MinObservations, from a country that would look unusual once a
	// real baseline exists.
	seedEvents(t, ch, tenantID, "new-employee", 5, start, 1, "DE", 12345, 500, 10)

	if err := store.Recompute(ctx, tenantID, time.Now().UTC()); err != nil {
		t.Fatalf("Recompute: %v", err)
	}

	b, err := store.GetBaseline(ctx, tenantID, "new-employee", MetricCountry)
	if err != nil {
		t.Fatalf("GetBaseline: %v", err)
	}
	if b.Valid {
		t.Fatalf("a 5-observation, 6-day-old entity should not yet have a valid baseline, got %+v", b)
	}
	for _, country := range []string{"US", "DE", "a-country-never-seen"} {
		if b.IsAnomalous(country) {
			t.Errorf("IsAnomalous(%q) = true for a brand-new entity, want false (novelty alone must never be treated as anomalous)", country)
		}
	}
}
