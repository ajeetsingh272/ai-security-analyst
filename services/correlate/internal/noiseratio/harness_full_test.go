//go:build integration && noiseratio_full

// A build tag of its own on top of `integration`, deliberately NOT run
// by the normal `go test -tags=integration ./...` sweep
// (scripts/go-test-integration.sh, ci-integration.yml) — mirroring
// P2-11's own `loadtest` tag split for the identical reason: this
// scale (Full, ~900 signals) is too slow to pay on every PR, so it
// runs nightly only (.github/workflows/noise-ratio-nightly.yml), via
// `go test -tags=integration,noiseratio_full`. Needs BOTH tags, not
// just this one, because it depends on helpers (newTestPool,
// createTenant, replay, measure) defined in
// harness_integration_test.go, which is itself gated on `integration`.
package noiseratio

import (
	"context"
	"testing"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/services/correlate/internal/cluster"
	"github.com/ajeetsingh272/ai-security-analyst/services/correlate/internal/reduction"
	"github.com/ajeetsingh272/ai-security-analyst/services/correlate/internal/scoring"
)

// The same three assertions TestNoiseRatio_ReferenceDatasetAtReducedScale
// makes, at the nightly "full week" scale — a separate test (not a
// loop over both scales in one) so each scale is independently
// selectable and independently named in a CI log.
func TestNoiseRatio_ReferenceDatasetAtFullScale(t *testing.T) {
	pool := newTestPool(t)
	tenantID := createTenant(t, pool)
	ctx := context.Background()
	threshold := scoring.EscalationThreshold(scoring.PlanMSP)

	weekStart := time.Date(2026, 2, 2, 0, 0, 0, 0, time.UTC)
	ds := Build(Full, weekStart)

	clusterer := cluster.NewClusterer(cluster.NewPostgresStore(pool), cluster.DefaultWindow)
	replay(t, ctx, tenantID, clusterer, ds)

	m := measure(t, ctx, pool, tenantID, threshold)

	if m.signalsIn != ds.TotalSignalCount {
		t.Fatalf("got %d signals clustered, want %d (the full dataset)", m.signalsIn, ds.TotalSignalCount)
	}
	if m.casesEscalated != 1 {
		t.Fatalf("got %d escalated cases, want exactly 1 (the seeded attack)", m.casesEscalated)
	}
	for i, score := range m.nonAttackScores {
		if score >= threshold {
			t.Errorf("benign case %d scored %v, at/above threshold %v — a false escalation", i, score, threshold)
		}
	}
	ratio, ok := reduction.Ratio(uint64(m.signalsIn), uint64(m.casesEscalated))
	if !ok {
		t.Fatal("reduction.Ratio reported not-ok for a non-zero signal count")
	}
	if ratio < 10 {
		t.Fatalf("got reduction ratio %v, want at least 10:1 (signals=%d, escalated=%d)", ratio, m.signalsIn, m.casesEscalated)
	}
	t.Logf("noise-ratio reference dataset (full scale): signals=%d escalated=%d ratio=%.1f:1",
		m.signalsIn, m.casesEscalated, ratio)
}
