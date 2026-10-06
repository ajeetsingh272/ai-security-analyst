package sentinelconnector

import (
	"context"
	"testing"
	"time"
)

// T2: token bucket refills at the configured rate. Tested against
// InMemoryTokenBucket — the same refill algorithm as RedisTokenBucket's Lua
// script (see ratelimit.go's own comment on why they must agree), kept as a
// genuine unit test with no Redis involved, matching the ticket's own
// classification of T2 as "unit" rather than "integration". The Lua
// script's own correctness against a REAL Redis is proven separately, in
// ratelimit_integration_test.go.
func TestTokenBucketRefillsAtConfiguredRate(t *testing.T) {
	b := NewInMemoryTokenBucket()
	ctx := context.Background()
	quota := Quota{EPS: 10, Burst: 10}

	// Drain the bucket completely.
	granted, err := b.Allow(ctx, "tenant-a", quota, 100)
	if err != nil {
		t.Fatalf("Allow: %v", err)
	}
	if granted != 10 {
		t.Fatalf("expected the full burst of 10 tokens granted immediately, got %d", granted)
	}

	// Immediately after draining, nothing is available.
	granted, err = b.Allow(ctx, "tenant-a", quota, 1)
	if err != nil {
		t.Fatalf("Allow: %v", err)
	}
	if granted != 0 {
		t.Fatalf("expected 0 tokens immediately after draining the bucket, got %d", granted)
	}

	// Manipulate the bucket's own clock directly rather than sleeping —
	// deterministic, and proves the rate (not just "eventually some tokens
	// appear").
	b.mu.Lock()
	b.buckets["tenant-a"].lastRefillMs -= 500 // simulate 500ms elapsed
	b.mu.Unlock()

	granted, err = b.Allow(ctx, "tenant-a", quota, 100)
	if err != nil {
		t.Fatalf("Allow: %v", err)
	}
	// 10 EPS over 500ms = 5 tokens refilled.
	if granted != 5 {
		t.Fatalf("expected 5 tokens refilled after 500ms at 10 EPS, got %d", granted)
	}
}

func TestTokenBucketNeverExceedsBurstCapacity(t *testing.T) {
	b := NewInMemoryTokenBucket()
	ctx := context.Background()
	quota := Quota{EPS: 10, Burst: 20}

	b.mu.Lock()
	b.buckets["tenant-a"] = &bucketState{tokens: 20, lastRefillMs: time.Now().UnixMilli() - 60_000} // 60s of "elapsed" time
	b.mu.Unlock()

	granted, err := b.Allow(ctx, "tenant-a", quota, 1000)
	if err != nil {
		t.Fatalf("Allow: %v", err)
	}
	// Even though 60s at 10 EPS would refill 600 tokens, the bucket caps at
	// Burst (20) — a long-idle tenant does not get an unbounded reservoir.
	if granted != 20 {
		t.Fatalf("expected capacity capped at Burst=20 regardless of idle time, got %d", granted)
	}
}

func TestTokenBucketIsolatesTenants(t *testing.T) {
	b := NewInMemoryTokenBucket()
	ctx := context.Background()
	quota := Quota{EPS: 10, Burst: 10}

	// Drain tenant A completely.
	if _, err := b.Allow(ctx, "tenant-a", quota, 10); err != nil {
		t.Fatalf("Allow: %v", err)
	}

	// Tenant B, same quota shape, must be unaffected — this is the actual
	// AC1 property ("does not affect others"), proven at the bucket level
	// rather than only at the scheduler level (T1's job).
	granted, err := b.Allow(ctx, "tenant-b", quota, 10)
	if err != nil {
		t.Fatalf("Allow: %v", err)
	}
	if granted != 10 {
		t.Fatalf("expected tenant B's full burst untouched by tenant A's usage, got %d", granted)
	}
}
