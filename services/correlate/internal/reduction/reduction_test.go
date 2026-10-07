package reduction

import (
	"math"
	"testing"
)

func TestRatio_ComputesSignalsOverCasesEscalated(t *testing.T) {
	ratio, ok := Ratio(100, 10)
	if !ok {
		t.Fatal("expected ok=true for a non-zero signal count")
	}
	if ratio != 10 {
		t.Errorf("got ratio %v, want 10", ratio)
	}
}

// T3: a tenant with zero signals produces no division error and no
// spurious alert.
func TestRatio_ZeroSignalsReturnsNotOK(t *testing.T) {
	ratio, ok := Ratio(0, 0)
	if ok {
		t.Fatal("expected ok=false for zero signals — a quiet tenant is not a degraded one")
	}
	if ratio != 0 {
		t.Errorf("got ratio %v for the not-ok case, want the zero value", ratio)
	}
}

func TestRatio_ZeroEscalatedCasesIsInfinityNotAPanic(t *testing.T) {
	ratio, ok := Ratio(50, 0)
	if !ok {
		t.Fatal("50 signals is a non-zero signal count; expected ok=true")
	}
	if !math.IsInf(ratio, 1) {
		t.Errorf("got ratio %v, want +Inf (every signal reduced to zero escalated cases is the best possible outcome, not an error)", ratio)
	}
}

func TestRatio_BelowEightIsDetectableByComparison(t *testing.T) {
	ratio, ok := Ratio(100, 20) // 5:1 — below the 8:1 floor
	if !ok {
		t.Fatal("expected ok=true")
	}
	if ratio >= 8 {
		t.Errorf("got ratio %v, want below 8 for this input", ratio)
	}
}
