package scoring

import "testing"

// Real ATT&CK technique IDs (go/sentinelattck's own pinned v19.2
// catalogue) in two different tactics, used throughout: T1110.003
// (credential-access) and T1136.003 (persistence).
const (
	techCredentialAccess = "T1110.003"
	techPersistence      = "T1136.003"
)

// T1: a multi-stage kill-chain case scores above a single-stage case
// with the same signal count — every other input held equal.
func TestScore_MultiStageKillChainOutranksSingleStage(t *testing.T) {
	singleStage := Score(Input{
		SignalCount: 2, Severities: []Severity{SeverityMedium, SeverityMedium},
		MitreIDs: []string{techCredentialAccess, techCredentialAccess},
	})
	multiStage := Score(Input{
		SignalCount: 2, Severities: []Severity{SeverityMedium, SeverityMedium},
		MitreIDs: []string{techCredentialAccess, techPersistence},
	})

	if multiStage.Total <= singleStage.Total {
		t.Fatalf("multi-stage total %v did not outrank single-stage total %v", multiStage.Total, singleStage.Total)
	}
	if multiStage.Components["killChainProgression"] <= singleStage.Components["killChainProgression"] {
		t.Errorf("multi-stage killChainProgression %v did not outrank single-stage %v",
			multiStage.Components["killChainProgression"], singleStage.Components["killChainProgression"])
	}
	// Nothing else should have moved — the ONLY difference is kill-chain stage.
	for _, key := range []string{"entityCriticality", "signalCount", "maxSeverity", "baselineDeviation"} {
		if singleStage.Components[key] != multiStage.Components[key] {
			t.Errorf("component %q differed (%v vs %v) when it should have been held equal", key, singleStage.Components[key], multiStage.Components[key])
		}
	}
}

func TestScore_SingleTechniqueInOneTacticIsSingleStage(t *testing.T) {
	// Two signals, same technique repeated — still exactly one tactic.
	r := Score(Input{SignalCount: 2, MitreIDs: []string{techCredentialAccess, techCredentialAccess}})
	if r.Components["killChainProgression"] != 0 {
		t.Errorf("single-tactic case has a non-zero killChainProgression: %v", r.Components["killChainProgression"])
	}
}

func TestScore_NoRecognisedTechniqueIsSingleStage(t *testing.T) {
	r := Score(Input{SignalCount: 1, MitreIDs: []string{"not-a-real-technique-id"}})
	if r.Components["killChainProgression"] != 0 {
		t.Errorf("unrecognised technique produced a non-zero killChainProgression: %v", r.Components["killChainProgression"])
	}
}

// T2: a case touching a flagged high-value identity scores above an
// equivalent case on an ordinary identity.
func TestScore_HighCriticalityEntityOutranksOrdinaryEntity(t *testing.T) {
	ordinary := Score(Input{SignalCount: 3, Severities: []Severity{SeverityHigh}, EntityCriticality: CriticalityNormal})
	flagged := Score(Input{SignalCount: 3, Severities: []Severity{SeverityHigh}, EntityCriticality: CriticalityHigh})

	if flagged.Total <= ordinary.Total {
		t.Fatalf("flagged-identity total %v did not outrank ordinary-identity total %v", flagged.Total, ordinary.Total)
	}
	for _, key := range []string{"signalCount", "maxSeverity", "killChainProgression", "baselineDeviation"} {
		if ordinary.Components[key] != flagged.Components[key] {
			t.Errorf("component %q differed when it should have been held equal", key)
		}
	}
}

// T3: scoring is deterministic across repeated invocations — equal
// Input (regardless of slice element order) always produces an equal
// Result.
func TestScore_IsDeterministicAcrossRepeatedInvocations(t *testing.T) {
	in := Input{
		SignalCount: 5, Severities: []Severity{SeverityLow, SeverityCritical, SeverityMedium},
		MitreIDs:          []string{techCredentialAccess, techPersistence, "unknown-id"},
		EntityCriticality: CriticalityHigh, BaselineDeviation: 0,
	}
	first := Score(in)
	for i := 0; i < 20; i++ {
		got := Score(in)
		if got.Total != first.Total {
			t.Fatalf("run %d: Total = %v, want %v (first run)", i, got.Total, first.Total)
		}
		for k, v := range first.Components {
			if got.Components[k] != v {
				t.Errorf("run %d: component %q = %v, want %v", i, k, got.Components[k], v)
			}
		}
	}
}

func TestScore_IsIndependentOfSliceOrder(t *testing.T) {
	a := Score(Input{Severities: []Severity{SeverityLow, SeverityCritical}, MitreIDs: []string{techCredentialAccess, techPersistence}})
	b := Score(Input{Severities: []Severity{SeverityCritical, SeverityLow}, MitreIDs: []string{techPersistence, techCredentialAccess}})
	if a.Total != b.Total {
		t.Errorf("reordering inputs changed the score: %v vs %v", a.Total, b.Total)
	}
}

// T4: stored score components reproduce the final score exactly.
func TestScore_ComponentsSumToTotal(t *testing.T) {
	inputs := []Input{
		{},
		{SignalCount: 1, Severities: []Severity{SeverityInfo}},
		{SignalCount: 10, Severities: []Severity{SeverityCritical, SeverityLow}, MitreIDs: []string{techCredentialAccess, techPersistence}, EntityCriticality: CriticalityHigh},
		{BaselineDeviation: 3.5},
	}
	for i, in := range inputs {
		r := Score(in)
		var sum float64
		for _, v := range r.Components {
			sum += v
		}
		if sum != r.Total {
			t.Errorf("input %d: components sum to %v, want Total %v", i, sum, r.Total)
		}
	}
}

func TestScore_AlwaysReportsAllFiveComponents(t *testing.T) {
	r := Score(Input{})
	want := []string{"entityCriticality", "signalCount", "maxSeverity", "killChainProgression", "baselineDeviation"}
	for _, key := range want {
		if _, ok := r.Components[key]; !ok {
			t.Errorf("missing component %q", key)
		}
	}
	if len(r.Components) != len(want) {
		t.Errorf("got %d components, want exactly %d", len(r.Components), len(want))
	}
}

func TestEscalationThreshold_VariesByPlanTier(t *testing.T) {
	if EscalationThreshold(PlanEnterprise) >= EscalationThreshold(PlanTrial) {
		t.Errorf("enterprise threshold (%v) should be lower than trial's (%v)", EscalationThreshold(PlanEnterprise), EscalationThreshold(PlanTrial))
	}
}

func TestIsEscalated_ComparesAgainstThePlanTiersOwnThreshold(t *testing.T) {
	score := EscalationThreshold(PlanPro)
	if !IsEscalated(score, PlanPro) {
		t.Errorf("a score exactly at the threshold should escalate")
	}
	if IsEscalated(score-0.01, PlanPro) {
		t.Errorf("a score just below the threshold should not escalate")
	}
}
