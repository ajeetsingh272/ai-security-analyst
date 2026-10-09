package sentinelstream

import (
	"context"
	"strings"
	"testing"
	"time"
)

const testTenantID = "tenant-shard-test"

// fakeClock lets a test advance ShardController's own notion of "now"
// deterministically — epsWindow/shardConfigTTL are both real-time-based,
// and a flaky sleep-based test would be exactly the kind of thing this
// repo's own CRLF/timing-flake discipline exists to avoid.
type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

// newTestController builds a ShardController with no real Postgres pool
// at all — quotaFunc is a same-package white-box seam (this file is in
// package sentinelstream) standing in for a real tenants.eps_quota read,
// and no background persist goroutine runs (NewShardController is what
// starts that; tests construct the struct literal directly and never
// call it), so enqueuePersist's own non-blocking channel send is safe
// to call without anything draining it.
func newTestController(t *testing.T, quota int) (*ShardController, *fakeClock) {
	t.Helper()
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	c := &ShardController{
		state:        map[string]*tenantShardState{},
		nowFunc:      clock.now,
		quotaFunc:    func(_ context.Context, _ string, _ int) int { return quota },
		persistQueue: make(chan shardPersist, 256),
		closed:       make(chan struct{}),
	}
	return c, clock
}

// publishN simulates N events published for tenantID within ONE
// simulated second, advancing the clock by `step` between each so the
// sliding window sees them as distinct ticks within the same window.
func publishN(c *ShardController, clock *fakeClock, tenantID string, n int, step time.Duration) []string {
	keys := make([]string, n)
	for i := 0; i < n; i++ {
		keys[i] = c.KeyFor(context.Background(), tenantID)
		clock.advance(step)
	}
	return keys
}

// AC5: "sharded and unsharded tenants behave identically" — the default,
// never-hot tenant must always get exactly TenantKey's own value, with
// no special-casing needed to prove it.
func TestKeyFor_NeverHotTenantAlwaysReturnsUnshardedKey(t *testing.T) {
	c, clock := newTestController(t, 1_000_000) // quota effectively never exceeded
	keys := publishN(c, clock, testTenantID, 50, 10*time.Millisecond)
	want := TenantKey(testTenantID)
	for i, k := range keys {
		if k != want {
			t.Fatalf("event %d: got key %q, want %q (an unsharded tenant must never see anything else)", i, k, want)
		}
	}
}

// AC1/T1: a tenant whose measured EPS exceeds its own configured
// threshold is automatically re-keyed across more than one shard.
func TestKeyFor_ScalesUpWhenEPSExceedsQuota(t *testing.T) {
	c, clock := newTestController(t, 5) // quota: 5 EPS

	// Publish well above 5 EPS: 100 events spread over ~1 simulated
	// second (10ms apart) — comfortably over quota.
	keys := publishN(c, clock, testTenantID, 100, 10*time.Millisecond)

	sawShard1OrHigher := false
	for _, k := range keys {
		if strings.Contains(k, ":") && k != TenantKey(testTenantID) {
			sawShard1OrHigher = true
			break
		}
	}
	if !sawShard1OrHigher {
		t.Fatalf("expected at least one event to be routed to a non-zero shard once EPS exceeded quota, got keys: %v", keys)
	}

	s := c.stateFor(testTenantID)
	s.mu.Lock()
	shardCount := s.currentShardCount
	s.mu.Unlock()
	if shardCount <= 1 {
		t.Fatalf("expected currentShardCount to have grown past 1, got %d", shardCount)
	}
}

// A hot tenant's own batch must spread ACROSS shards, not just pick one
// shard for a whole publish cycle and rotate only between cycles —
// otherwise a single large batch still concentrates entirely on one
// partition, defeating the whole point.
func TestKeyFor_RoundRobinsAcrossShardsOnceHot(t *testing.T) {
	c, clock := newTestController(t, 1) // tiny quota: hot almost immediately

	// Force scale-up first.
	publishN(c, clock, testTenantID, 50, 10*time.Millisecond)
	s := c.stateFor(testTenantID)
	s.mu.Lock()
	shardCount := s.currentShardCount
	s.mu.Unlock()
	if shardCount < 2 {
		t.Fatalf("expected the tenant to already be sharded (count > 1) before checking round-robin, got %d", shardCount)
	}

	seen := map[string]bool{}
	for _, k := range publishN(c, clock, testTenantID, shardCount*3, time.Millisecond) {
		seen[k] = true
	}
	if len(seen) < 2 {
		t.Fatalf("expected multiple distinct shard keys once hot, got only: %v", seen)
	}
}

// T4: once load drops comfortably below quota for long enough, the
// tenant is un-sharded back down — and never below shard 1 (the same
// floor the unsharded default already is).
func TestKeyFor_ScalesDownAfterLoadDrops(t *testing.T) {
	c, clock := newTestController(t, 5)

	// Force scale-up.
	publishN(c, clock, testTenantID, 200, 5*time.Millisecond)
	s := c.stateFor(testTenantID)
	s.mu.Lock()
	hotShardCount := s.currentShardCount
	s.mu.Unlock()
	if hotShardCount <= 1 {
		t.Fatalf("expected the tenant to be sharded before testing scale-down, got %d", hotShardCount)
	}

	// Let the window go quiet: advance well past the EPS window with no
	// new events, then publish a single trickle to trigger a re-check.
	clock.advance(epsWindowSeconds * time.Second)
	for i := 0; i < 20; i++ {
		c.KeyFor(context.Background(), testTenantID)
		clock.advance(time.Second) // one event per second — far under quota
	}

	s.mu.Lock()
	finalShardCount := s.currentShardCount
	s.mu.Unlock()
	if finalShardCount != 1 {
		t.Fatalf("expected the tenant to un-shard back to 1 after load dropped, got %d", finalShardCount)
	}
}

// A runaway-hot tenant can never claim more than maxShardCount shards,
// regardless of how extreme its measured EPS is.
func TestKeyFor_NeverExceedsMaxShardCount(t *testing.T) {
	c, clock := newTestController(t, 1)
	publishN(c, clock, testTenantID, 2000, 100*time.Microsecond)

	s := c.stateFor(testTenantID)
	s.mu.Lock()
	shardCount := s.currentShardCount
	s.mu.Unlock()
	if shardCount > maxShardCount {
		t.Fatalf("currentShardCount = %d, must never exceed maxShardCount (%d)", shardCount, maxShardCount)
	}
}

// Two different tenants are tracked entirely independently — one
// tenant's own hot streak must never shard an unrelated, quiet tenant.
func TestKeyFor_TenantsAreIndependent(t *testing.T) {
	c, clock := newTestController(t, 5)
	publishN(c, clock, "hot-tenant", 200, 5*time.Millisecond)
	quietKey := c.KeyFor(context.Background(), "quiet-tenant")

	if quietKey != TenantKey("quiet-tenant") {
		t.Fatalf("expected the quiet tenant to stay unsharded despite a different hot tenant, got key %q", quietKey)
	}
}
