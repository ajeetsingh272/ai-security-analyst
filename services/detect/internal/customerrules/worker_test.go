package customerrules

import (
	"testing"

	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/sigmac"
)

type fakeRuleProvider struct {
	rules map[string][]LoadedRule
}

func (f *fakeRuleProvider) Active(tenantID string) []LoadedRule {
	return f.rules[tenantID]
}

func TestFlatten_CarriesTenantAndEventFields(t *testing.T) {
	wev := wireEvent{
		TenantID: "tenant-a", EventID: "evt-1", ClassUID: 3002, CategoryUID: 3, ActivityID: 1, SeverityID: 1,
		Metadata: map[string]string{"operation": "Consent to application."},
		Unmapped: map[string]string{"ConsentType": "AdminConsent"},
	}
	flat := flatten(wev)

	want := map[string]string{
		"tenant_id":            "tenant-a",
		"class_uid":            "3002",
		"category_uid":         "3",
		"activity_id":          "1",
		"severity_id":          "1",
		"metadata.event_id":    "evt-1",
		"metadata.operation":   "Consent to application.",
		"unmapped.ConsentType": "AdminConsent",
	}
	for k, v := range want {
		if flat[k] != v {
			t.Errorf("flat[%q] = %q, want %q", k, flat[k], v)
		}
	}
}

// ADR-0012 §4: the central safety property, proven directly — two
// tenants each with their own active rule, one event belonging to
// tenant-a, and tenant-b's rule never even gets a chance to run
// against it (Active is only ever called with the event's own tenant).
func TestEvaluate_NeverEvaluatesAnotherTenantsRules(t *testing.T) {
	ruleA, err := Validate("row-a", validRuleYAML)
	if err != nil {
		t.Fatalf("Validate rule A: %v", err)
	}
	ruleB, err := Validate("row-b", validRuleYAML)
	if err != nil {
		t.Fatalf("Validate rule B: %v", err)
	}
	provider := &fakeRuleProvider{rules: map[string][]LoadedRule{
		"tenant-a": {{RowID: "row-a", Rule: ruleA}},
		"tenant-b": {{RowID: "row-b", Rule: ruleB}},
	}}

	wev := wireEvent{TenantID: "tenant-a", EventID: "evt-1", Metadata: map[string]string{"operation": "Consent to application."}, Unmapped: map[string]string{"ConsentType": "AdminConsent"}}
	signals, outcomes := evaluate(provider, wev)

	if len(outcomes) != 1 || outcomes[0].RowID != "row-a" {
		t.Fatalf("outcomes = %+v, want exactly one outcome for tenant-a's own rule (row-a)", outcomes)
	}
	if len(signals) != 1 || signals[0].TenantID != "tenant-a" {
		t.Fatalf("signals = %+v, want exactly one signal for tenant-a", signals)
	}
}

func TestEvaluate_MatchingRuleProducesASignalTaggedCustomerRule(t *testing.T) {
	r, err := Validate("row-a", validRuleYAML)
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	provider := &fakeRuleProvider{rules: map[string][]LoadedRule{"tenant-a": {{RowID: "row-a", Rule: r}}}}

	wev := wireEvent{TenantID: "tenant-a", EventID: "evt-1", Metadata: map[string]string{"operation": "Consent to application."}, Unmapped: map[string]string{"ConsentType": "AdminConsent"}}
	signals, _ := evaluate(provider, wev)

	if len(signals) != 1 {
		t.Fatalf("got %d signals, want 1", len(signals))
	}
	sig := signals[0]
	if sig.Engine != engineCustomerRule {
		t.Errorf("Engine = %q, want %q", sig.Engine, engineCustomerRule)
	}
	if sig.RuleID != r.ID {
		t.Errorf("RuleID = %q, want %q", sig.RuleID, r.ID)
	}
	if sig.EventIDs[0] != "evt-1" {
		t.Errorf("EventIDs[0] = %q, want evt-1", sig.EventIDs[0])
	}
}

func TestEvaluate_NonMatchingRuleProducesNoSignalButStillAnOutcome(t *testing.T) {
	r, err := Validate("row-a", validRuleYAML)
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	provider := &fakeRuleProvider{rules: map[string][]LoadedRule{"tenant-a": {{RowID: "row-a", Rule: r}}}}

	wev := wireEvent{TenantID: "tenant-a", EventID: "evt-1", Metadata: map[string]string{"operation": "Consent to application."}, Unmapped: map[string]string{"ConsentType": "UserConsent"}}
	signals, outcomes := evaluate(provider, wev)

	if len(signals) != 0 {
		t.Fatalf("got %d signals, want 0 for a non-matching event", len(signals))
	}
	if len(outcomes) != 1 || outcomes[0].RowID != "row-a" {
		t.Fatalf("outcomes = %+v, want exactly one outcome recorded even though the rule did not match", outcomes)
	}
}

// A panicking rule must not stop OTHER rules in the same event from
// being evaluated — the same single-rule isolation worker.safeMatch
// already guarantees for the compiled corpus.
func TestEvaluate_PanickingRuleDoesNotBlockOtherRules(t *testing.T) {
	good, err := Validate("row-good", validRuleYAML)
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	// A Rule with a nil Selections map makes evaluateCondition's own
	// lookup panic-free in practice, so instead this test directly
	// exercises safeEvaluate's recovery with a deliberately nil Rule
	// pointer, which DOES panic inside sigmac.Evaluate.
	matched, took, panicErr := safeEvaluate(nil, sigmac.Event{})
	if panicErr == nil {
		t.Fatal("expected a nil *sigmac.Rule to panic and be recovered")
	}
	if matched {
		t.Error("a panicking evaluation must report matched=false")
	}
	if took <= evaluationBudget {
		t.Error("a panicking evaluation must be reported as over-budget (TimedOut=true upstream)")
	}

	provider := &fakeRuleProvider{rules: map[string][]LoadedRule{
		"tenant-a": {{RowID: "row-bad", Rule: nil}, {RowID: "row-good", Rule: good}},
	}}
	wev := wireEvent{TenantID: "tenant-a", EventID: "evt-1", Metadata: map[string]string{"operation": "Consent to application."}, Unmapped: map[string]string{"ConsentType": "AdminConsent"}}
	signals, outcomes := evaluate(provider, wev)

	if len(outcomes) != 2 {
		t.Fatalf("got %d outcomes, want 2 (one per rule, including the panicking one)", len(outcomes))
	}
	if len(signals) != 1 || signals[0].RuleID != good.ID {
		t.Fatalf("signals = %+v, want exactly one signal from the good rule despite the other panicking", signals)
	}
}
