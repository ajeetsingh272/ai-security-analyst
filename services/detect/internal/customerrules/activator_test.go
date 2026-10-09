package customerrules

import (
	"context"
	"testing"
)

type fakeActivatorStore struct {
	pending  []PendingRule
	active   map[string]bool   // ruleID -> activated
	rejected map[string]string // ruleID -> reason
}

func newFakeActivatorStore(pending ...PendingRule) *fakeActivatorStore {
	return &fakeActivatorStore{pending: pending, active: map[string]bool{}, rejected: map[string]string{}}
}

func (f *fakeActivatorStore) PendingRules(context.Context) ([]PendingRule, error) {
	return f.pending, nil
}

func (f *fakeActivatorStore) MarkActive(_ context.Context, _, ruleID string) error {
	f.active[ruleID] = true
	return nil
}

func (f *fakeActivatorStore) MarkRejected(_ context.Context, _, ruleID, reason string) error {
	f.rejected[ruleID] = reason
	return nil
}

// T4: "A rule failing its own fixtures cannot be activated."
func TestActivator_ActivatesARuleThatPassesValidationAndItsOwnFixtures(t *testing.T) {
	store := newFakeActivatorStore(PendingRule{
		ID: "row-1", TenantID: "tenant-a", RuleYAML: validRuleYAML,
		PositiveFixture: matchingFixture, NegativeFixture: nonMatchingFixture,
	})
	NewActivator(store, nil).runOnce(context.Background())

	if !store.active["row-1"] {
		t.Fatalf("expected row-1 to be activated, got active=%v rejected=%v", store.active, store.rejected)
	}
}

func TestActivator_RejectsARuleThatFailsValidation(t *testing.T) {
	store := newFakeActivatorStore(PendingRule{
		ID: "row-1", TenantID: "tenant-a", RuleYAML: "not valid sigma yaml at all:::",
		PositiveFixture: matchingFixture, NegativeFixture: nonMatchingFixture,
	})
	NewActivator(store, nil).runOnce(context.Background())

	if store.active["row-1"] {
		t.Fatal("expected row-1 NOT to be activated")
	}
	if store.rejected["row-1"] == "" {
		t.Fatal("expected row-1 to be rejected with a reason")
	}
}

// T4's own exact scenario: the rule itself is well-formed and within
// every ADR-0012 §1 limit, but its own submitted positive fixture does
// not match it.
func TestActivator_RejectsARuleThatFailsItsOwnFixtures(t *testing.T) {
	store := newFakeActivatorStore(PendingRule{
		ID: "row-1", TenantID: "tenant-a", RuleYAML: validRuleYAML,
		PositiveFixture: nonMatchingFixture, // does not match — the rule's own condition requires AdminConsent
		NegativeFixture: nonMatchingFixture,
	})
	NewActivator(store, nil).runOnce(context.Background())

	if store.active["row-1"] {
		t.Fatal("expected row-1 NOT to be activated")
	}
	if store.rejected["row-1"] == "" {
		t.Fatal("expected row-1 to be rejected with a reason")
	}
}

// One tenant's bad rule must not block another tenant's good one in
// the same poll — the same "one bad row never blocks another" doctrine
// Loader already applies at load time, here at activation time.
func TestActivator_OneTenantsRejectionDoesNotBlockAnothers(t *testing.T) {
	store := newFakeActivatorStore(
		PendingRule{ID: "row-1", TenantID: "tenant-a", RuleYAML: "not valid:::", PositiveFixture: matchingFixture, NegativeFixture: nonMatchingFixture},
		PendingRule{ID: "row-2", TenantID: "tenant-b", RuleYAML: validRuleYAML, PositiveFixture: matchingFixture, NegativeFixture: nonMatchingFixture},
	)
	NewActivator(store, nil).runOnce(context.Background())

	if store.active["row-1"] {
		t.Fatal("row-1 should have been rejected, not activated")
	}
	if !store.active["row-2"] {
		t.Fatal("row-2 should have been activated despite row-1's rejection")
	}
}
