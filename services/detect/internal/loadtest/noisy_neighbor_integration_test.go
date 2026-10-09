//go:build loadtest

package loadtest

import (
	"context"
	"testing"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
)

// T3 (P7-04, reduced scale, CI-feasible) — same "CI runs a reduced-scale
// regression gate, the ticket's own literal number is run manually and
// recorded in the PR" convention harness_integration_test.go's own doc
// comment already establishes for P2-11/#122's 30k EPS. This test's own
// job: prove the MECHANISM (a sharded hot tenant's flood does not blow
// out a quiet tenant's own latency) at a scale this shared CI/dev
// environment can sustain reliably, not reproduce the literal 10,000
// number on every PR.
//
// Same //go:build loadtest isolation reasoning as harness_integration_test.go's
// own doc comment: this produces real sustained load against the shared
// Redpanda and must not run concurrently with unrelated integration
// tests touching the same topics.
func TestNoisyNeighbor_ReducedScaleRegressionGate(t *testing.T) {
	ctx := context.Background()
	pool, err := sentineldb.NewPool(ctx)
	if err != nil {
		t.Fatalf("opening pool: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("Postgres not reachable (pnpm dev:stack running?): %v", err)
	}

	runCtx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	report, err := RunNoisyNeighborCheck(runCtx, NoisyNeighborConfig{
		Brokers:        brokers,
		Pool:           pool,
		HotTenantEPS:   2000,
		QuietTenantEPS: 50,
		Duration:       20 * time.Second,
		WorkerCount:    4,
		MatchEveryN:    20,
		DrainGrace:     15 * time.Second,
	})
	if err != nil {
		t.Fatalf("RunNoisyNeighborCheck: %v", err)
	}

	t.Logf("hot: achieved=%.0f EPS p99=%.1fms final_shards=%d | quiet: achieved=%.1f EPS p50=%.1fms p99=%.1fms",
		report.HotTenantAchievedEPS, report.HotTenantP99Ms, report.HotTenantFinalShards,
		report.QuietTenantAchievedEPS, report.QuietTenantP50Ms, report.QuietTenantP99Ms)

	if report.HotTenantFinalShards <= 1 {
		t.Fatalf("expected the flooding tenant to have been auto-sharded (final shard count > 1), got %d — the controller never engaged, so this run proves nothing about noisy-neighbor isolation", report.HotTenantFinalShards)
	}
	if report.QuietTenantAchievedEPS < float64(50)*0.5 {
		t.Fatalf("expected the quiet tenant's own production to keep up with its target rate despite the flood, got %.1f EPS (target 50)", report.QuietTenantAchievedEPS)
	}
	// A generous absolute bound, not a before/after comparison — same
	// "a shared, loaded CI box doesn't clear the product's own tight
	// latency ceiling" honesty harness_integration_test.go's own doc
	// comment already discloses for the primary harness. The claim this
	// asserts is narrower and still real: a quiet tenant's own signals
	// keep arriving at all, within a bound far looser than the product's
	// own 100ms target, while a neighbor is sustained at 40x its rate.
	if report.QuietTenantP99Ms > 2000 {
		t.Fatalf("quiet tenant's own p99 latency was %.1fms while a neighbor was flooded — expected it to stay well under 2000ms", report.QuietTenantP99Ms)
	}
}
