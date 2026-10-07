package loadtest

import "testing"

var testBaseline = Baseline{P50Ms: 50, EPS: 3000, Note: "test baseline"}

func TestCompareToBaseline_NoRegressionPasses(t *testing.T) {
	r := Report{LatencyP50Ms: 52, AchievedEPS: 2950} // within 10% both ways
	if got := CompareToBaseline(r, testBaseline); len(got) != 0 {
		t.Fatalf("got violations %v, want none for a result within 10%% of baseline", got)
	}
}

// T3: "A deliberately introduced 20% regression fails the gate." A p50
// 20% above baseline must be flagged — the regression this ticket's own
// test case describes. See Baseline's own doc comment for why this
// gate checks p50, not p99 (p99 off a CI-feasible sample size proved too
// noisy on real, repeated runs to serve as a reliable regression signal).
func TestCompareToBaseline_20PercentLatencyRegressionFails(t *testing.T) {
	r := Report{LatencyP50Ms: testBaseline.P50Ms * 1.20, AchievedEPS: testBaseline.EPS}
	violations := CompareToBaseline(r, testBaseline)
	if len(violations) != 1 || violations[0].Metric != "p50_latency_ms" {
		t.Fatalf("got %v, want exactly one p50_latency_ms violation", violations)
	}
}

// T3's own throughput counterpart: EPS dropping 20% below baseline is
// just as real a regression as latency rising, and must fail the same
// way.
func TestCompareToBaseline_20PercentThroughputRegressionFails(t *testing.T) {
	r := Report{LatencyP50Ms: testBaseline.P50Ms, AchievedEPS: testBaseline.EPS * 0.80}
	violations := CompareToBaseline(r, testBaseline)
	if len(violations) != 1 || violations[0].Metric != "achieved_eps" {
		t.Fatalf("got %v, want exactly one achieved_eps violation", violations)
	}
}

func TestCompareToBaseline_ExactlyAtTenPercentPasses(t *testing.T) {
	r := Report{LatencyP50Ms: testBaseline.P50Ms * 1.10, AchievedEPS: testBaseline.EPS * 0.90}
	if got := CompareToBaseline(r, testBaseline); len(got) != 0 {
		t.Fatalf("got violations %v, want none exactly at the 10%% boundary", got)
	}
}

func TestCheckAbsoluteThresholds_Under100msPasses(t *testing.T) {
	if got := CheckAbsoluteThresholds(Report{LatencyP99Ms: 99.9}); len(got) != 0 {
		t.Fatalf("got violations %v, want none under the 100ms ceiling", got)
	}
}

func TestCheckAbsoluteThresholds_Over100msFails(t *testing.T) {
	violations := CheckAbsoluteThresholds(Report{LatencyP99Ms: 150})
	if len(violations) != 1 || violations[0].Metric != "p99_latency_ms" {
		t.Fatalf("got %v, want exactly one p99_latency_ms violation", violations)
	}
}
