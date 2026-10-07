//go:build loadtest

// A build tag of its own, deliberately NOT `integration`. scripts/
// go-test-integration.sh runs every `integration`-tagged test across
// every module in ONE `go test ./...` pass, and Go runs that pass's
// different PACKAGES concurrently by default — this test's own ~2,000
// EPS sustained production is enough concurrent load against the shared
// Redpanda to make services/detect/internal/worker's own, otherwise
// solid, integration tests intermittently see duplicate/delayed signals
// (confirmed directly: worker's suite passed 100% alone, then failed
// with duplicate signals only when run as part of the same `go test
// ./...` as this package). A load test inherently wants the infrastructure
// it's measuring to itself, not sharing it with unrelated correctness
// tests running at the same time — hence its own tag, run as its own,
// separate, SEQUENTIAL CI step (ci-integration.yml) rather than folded
// into the parallel integration sweep.
package loadtest

import (
	"context"
	"testing"
	"time"
)

const brokers = "localhost:19092"

// Deliberately NO TestMain truncating events.normalized/signals here,
// unlike services/detect/internal/worker's own TestMain. Go runs
// different PACKAGES' test binaries concurrently by default within one
// `go test ./...` invocation (scripts/go-test-integration.sh's own loop
// runs exactly that, once per module) — worker's and this package's test
// binaries both touch the SAME physical shared topics, so a second
// package independently truncating them mid-run is a real, observed
// hazard, not a theoretical one: adding it here caused worker's own
// suppression tests to intermittently see a stray signal when the two
// ran in the same `go test -tags=integration ./...` pass, despite each
// package passing cleanly alone. This test's correctness already comes
// entirely from filtering every topic read by this run's own unique
// tenant id (see Run's own runID), never from the topic starting empty —
// a backlog only ever costs this test TIME (draining it before reaching
// its own records), never correctness. A real CI run starts from a
// freshly created, empty stack anyway; a developer who repeatedly runs
// `go run ./cmd/loadtest` by hand many times locally is responsible for
// their own topic hygiene (e.g. `pnpm dev:stack:down && pnpm dev:stack`),
// the same way running any other load generator repeatedly would be.

// T1 (reduced scale, CI-feasible) + T2: a real, reduced-scale run against
// real Redpanda, with every signal's real end-to-end latency and the
// real process's own goroutine/heap samples throughout — this is the
// literal "the harness is runnable locally at reduced scale" AC,
// exercised automatically on every PR via pnpm go:test:integration
// (scripts/go-test-integration.sh already runs every //go:build
// integration test in this module; no new CI plumbing was needed).
//
// Deliberately does NOT call CheckAbsoluteThresholds — see baseline.json's
// own note for why: this shared, full-stack-on-one-machine CI/dev
// environment does not currently clear the ticket's literal 100ms ceiling
// at ANY scale tested (see the PR description for the full-scale, 30k EPS
// finding), so asserting that here would fail on every run regardless of
// whether a real regression exists. This test's job is narrower and still
// genuinely useful: catch a FUTURE regression beyond today's own real,
// committed numbers (T3's own CompareToBaseline, exercised for real here
// rather than only against the synthetic Reports baseline_test.go uses).
func TestLoadTest_ReducedScaleRegressionGate(t *testing.T) {
	baseline, err := DefaultBaseline()
	if err != nil {
		t.Fatalf("loading embedded baseline: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	report, err := Run(ctx, Config{
		Brokers:     brokers,
		TargetEPS:   2000,
		Duration:    20 * time.Second,
		WorkerCount: 2,
		MatchEveryN: 20,
		DrainGrace:  15 * time.Second,
		SampleEvery: 3 * time.Second,
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	t.Logf("report: produced=%d achieved_eps=%.1f p50=%.1fms p95=%.1fms p99=%.1fms signals=%d/%d goroutines=%d->%d (peak %d) heap_peak=%.1fMB",
		report.Produced, report.AchievedEPS, report.LatencyP50Ms, report.LatencyP95Ms, report.LatencyP99Ms,
		report.SignalsReceived, report.SignalsExpected,
		report.GoroutinesStart, report.GoroutinesEnd, report.GoroutinesPeak, report.HeapAllocPeakMB,
	)

	if report.SignalsReceived != report.SignalsExpected {
		t.Errorf("signals received = %d, want %d (expected matches dropped somewhere in the pipeline)", report.SignalsReceived, report.SignalsExpected)
	}

	// T2: no goroutine leak. GoroutinesStart/End are NOT the right pair
	// to compare here — the very first sample predates the load
	// producer and signal collector even being constructed (they start
	// after it), so a jump from "start" to "steady state" is ordinary
	// ramp-up, not a leak. The real signal is whether goroutine count
	// PLATEAUS once every component is up, rather than climbing without
	// bound for the rest of the run — checked by comparing the run's
	// later samples (after ramp-up has clearly finished) against each
	// other, not against the pre-ramp-up baseline.
	if len(report.ResourceSamples) >= 4 {
		later := report.ResourceSamples[len(report.ResourceSamples)/2:]
		minG, maxG := later[0].Goroutines, later[0].Goroutines
		for _, s := range later {
			if s.Goroutines < minG {
				minG = s.Goroutines
			}
			if s.Goroutines > maxG {
				maxG = s.Goroutines
			}
		}
		if maxG-minG > 8 {
			t.Errorf("goroutine count still climbing in the back half of the run (min=%d max=%d) — possible leak", minG, maxG)
		}
	}

	if violations := CompareToBaseline(report, baseline); len(violations) > 0 {
		for _, v := range violations {
			t.Errorf("regression beyond 10%% of baseline: %s", v)
		}
	}
}
