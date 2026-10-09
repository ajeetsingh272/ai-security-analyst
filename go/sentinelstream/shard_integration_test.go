//go:build integration

package sentinelstream

import (
	"context"
	"testing"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Requires: pnpm dev:stack && pnpm db:migrate. Run via:
//
//	go test -tags=integration ./go/sentinelstream/...
func withIntegrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	pool, err := sentineldb.NewPool(ctx)
	if err != nil {
		t.Fatalf("opening pool: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Skipf("Postgres not reachable (pnpm dev:stack running?): %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func asAdmin[T any](ctx context.Context, pool *pgxpool.Pool, fn func(tx pgx.Tx) (T, error)) (T, error) {
	var zero T
	tx, err := pool.Begin(ctx)
	if err != nil {
		return zero, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SET LOCAL ROLE sentinel_app"); err != nil {
		return zero, err
	}
	result, err := fn(tx)
	if err != nil {
		return zero, err
	}
	if err := tx.Commit(ctx); err != nil {
		return zero, err
	}
	return result, nil
}

func seedTenantWithQuota(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string, epsQuota int) string {
	t.Helper()
	tenantID, err := asAdmin(ctx, pool, func(tx pgx.Tx) (string, error) {
		var id string
		err := tx.QueryRow(ctx, `INSERT INTO tenants (name, plan, eps_quota) VALUES ($1, 'trial', $2) RETURNING id`, name, epsQuota).Scan(&id)
		return id, err
	})
	if err != nil {
		t.Fatalf("creating tenant: %v", err)
	}
	t.Cleanup(func() {
		_, _ = asAdmin(ctx, pool, func(tx pgx.Tx) (struct{}, error) {
			_, err := tx.Exec(ctx, "DELETE FROM tenants WHERE id = $1", tenantID)
			return struct{}{}, err
		})
	})
	return tenantID
}

func readShardCount(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tenantID string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, `SELECT shard_count FROM tenants WHERE id = $1`, tenantID).Scan(&n); err != nil {
		t.Fatalf("reading shard_count: %v", err)
	}
	return n
}

// T1: "A tenant crossing the threshold is sharded automatically" —
// against REAL Postgres: a real tenants.eps_quota row, read for real by
// ShardController.fetchEPSQuota (not the quotaFunc test seam), with real
// publish volume driving a real scale-up decision whose result is
// genuinely persisted back to tenants.shard_count.
func TestShardController_AgainstRealPostgres_CrossingThresholdShardsAutomatically(t *testing.T) {
	ctx := context.Background()
	pool := withIntegrationPool(t)
	tenantID := seedTenantWithQuota(t, ctx, pool, "P7-04 shard-up probe", 5)

	c := NewShardController(pool)
	defer c.Close()

	var sawSharded bool
	for i := 0; i < 200; i++ {
		key := c.KeyFor(ctx, tenantID)
		if key != TenantKey(tenantID) {
			sawSharded = true
		}
	}
	if !sawSharded {
		t.Fatal("expected at least one event to be routed to a non-zero shard after sustained publishing above the real eps_quota")
	}

	// The async persist loop needs a moment to actually land the write.
	deadline := time.Now().Add(5 * time.Second)
	var persisted int
	for time.Now().Before(deadline) {
		persisted = readShardCount(t, ctx, pool, tenantID)
		if persisted > 1 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if persisted <= 1 {
		t.Fatalf("expected tenants.shard_count to be persisted above 1, got %d", persisted)
	}
}

// T4: "Un-sharding a tenant that falls below threshold is safe" —
// against real Postgres: force a real scale-up, then let the window go
// quiet and confirm it genuinely un-shards back to 1, AND that
// un-sharded value is persisted too (not just held in memory).
func TestShardController_AgainstRealPostgres_FallingBelowThresholdUnshardsSafely(t *testing.T) {
	ctx := context.Background()
	pool := withIntegrationPool(t)
	tenantID := seedTenantWithQuota(t, ctx, pool, "P7-04 shard-down probe", 5)

	c := NewShardController(pool)
	defer c.Close()

	for i := 0; i < 200; i++ {
		c.KeyFor(ctx, tenantID)
	}
	s := c.stateFor(tenantID)
	s.mu.Lock()
	hotCount := s.currentShardCount
	s.mu.Unlock()
	if hotCount <= 1 {
		t.Fatalf("expected the tenant to be sharded before testing scale-down, got %d", hotCount)
	}

	// Simulate load dropping: advance the controller's own clock well
	// past the EPS window (real wall-clock sleep here, deliberately
	// short — this is the one place a real-time wait is the simplest
	// honest way to prove it, since nowFunc is the real clock in this
	// production-path test, unlike shard_test.go's own fake-clock unit
	// tests).
	time.Sleep((epsWindowSeconds + 1) * time.Second)
	for i := 0; i < 5; i++ {
		c.KeyFor(ctx, tenantID)
		time.Sleep(time.Second)
	}

	s.mu.Lock()
	finalCount := s.currentShardCount
	s.mu.Unlock()
	if finalCount != 1 {
		t.Fatalf("expected the tenant to un-shard back to 1, got %d", finalCount)
	}

	deadline := time.Now().Add(5 * time.Second)
	var persisted int
	for time.Now().Before(deadline) {
		persisted = readShardCount(t, ctx, pool, tenantID)
		if persisted == 1 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if persisted != 1 {
		t.Fatalf("expected tenants.shard_count to be persisted back to 1, got %d", persisted)
	}
}

// AC5, against real Postgres this time: a tenant whose eps_quota is
// never exceeded reads its real row every shardConfigTTL tick and still
// never deviates from the unsharded key.
func TestShardController_AgainstRealPostgres_NeverHotTenantStaysUnsharded(t *testing.T) {
	ctx := context.Background()
	pool := withIntegrationPool(t)
	tenantID := seedTenantWithQuota(t, ctx, pool, "P7-04 never-hot probe", 500) // the schema's own default

	c := NewShardController(pool)
	defer c.Close()

	for i := 0; i < 50; i++ {
		key := c.KeyFor(ctx, tenantID)
		if key != TenantKey(tenantID) {
			t.Fatalf("expected an unsharded key, got %q", key)
		}
	}
	if got := readShardCount(t, ctx, pool, tenantID); got != 1 {
		t.Fatalf("expected tenants.shard_count to remain 1, got %d", got)
	}
}
