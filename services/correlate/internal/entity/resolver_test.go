package entity

import (
	"context"
	"testing"
)

const tenantA = "11111111-1111-1111-1111-111111111111"
const tenantB = "22222222-2222-2222-2222-222222222222"

// T1: UPN, object id and email for one user resolve to a single
// entity — proven by resolving them SEPARATELY, one event at a time
// (the realistic case: no single M365 audit record carries all three
// at once), relying on ADR-0011's own co-occurrence chain: event 1
// links UPN+ObjectID; event 2 links ObjectID+Email, which already
// resolves to the SAME entity ObjectID settled on in event 1.
func TestResolve_UPNObjectIDAndEmailResolveToOneEntity(t *testing.T) {
	r := NewResolver(NewInMemoryStore())
	ctx := context.Background()

	e1, err := r.Resolve(ctx, tenantA, "user", []Alias{
		{Type: AliasUPN, Value: "alice@contoso.com"},
		{Type: AliasObjectID, Value: "obj-alice-1"},
	})
	if err != nil {
		t.Fatalf("Resolve (event 1): %v", err)
	}

	e2, err := r.Resolve(ctx, tenantA, "user", []Alias{
		{Type: AliasObjectID, Value: "obj-alice-1"},
		{Type: AliasEmail, Value: "alice.smith@contoso.com"},
	})
	if err != nil {
		t.Fatalf("Resolve (event 2): %v", err)
	}

	if e1.ID != e2.ID {
		t.Fatalf("UPN+ObjectID resolved to %s, ObjectID+Email resolved to %s — want the same entity", e1.ID, e2.ID)
	}

	// All three aliases must now point at the one entity, including a
	// THIRD, independent resolve call using only the UPN.
	e3, err := r.Resolve(ctx, tenantA, "user", []Alias{{Type: AliasUPN, Value: "alice@contoso.com"}})
	if err != nil {
		t.Fatalf("Resolve (UPN alone): %v", err)
	}
	if e3.ID != e1.ID {
		t.Fatalf("UPN-alone resolved to %s, want the same entity %s", e3.ID, e1.ID)
	}
}

// T1's own co-occurrence case: all three aliases arriving TOGETHER on
// one event must also resolve to one entity (not three).
func TestResolve_CoOccurringAliasesInOneCallResolveToOneEntity(t *testing.T) {
	r := NewResolver(NewInMemoryStore())
	ctx := context.Background()

	e, err := r.Resolve(ctx, tenantA, "user", []Alias{
		{Type: AliasUPN, Value: "bob@contoso.com"},
		{Type: AliasObjectID, Value: "obj-bob-1"},
		{Type: AliasEmail, Value: "bob@contoso.com"},
	})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if e.Status != StatusResolved {
		t.Errorf("Status = %q, want %q", e.Status, StatusResolved)
	}
}

// T2: identical email addresses in two tenants resolve to two distinct
// entities — AC2's own hard tenant-isolation requirement.
func TestResolve_IdenticalEmailInTwoTenantsResolvesToDistinctEntities(t *testing.T) {
	r := NewResolver(NewInMemoryStore())
	ctx := context.Background()
	alias := []Alias{{Type: AliasEmail, Value: "shared-looking-name@example.com"}}

	eA, err := r.Resolve(ctx, tenantA, "user", alias)
	if err != nil {
		t.Fatalf("Resolve tenant A: %v", err)
	}
	eB, err := r.Resolve(ctx, tenantB, "user", alias)
	if err != nil {
		t.Fatalf("Resolve tenant B: %v", err)
	}

	if eA.ID == eB.ID {
		t.Fatalf("tenant A and tenant B resolved the identical email to the SAME entity %s — tenant isolation violated", eA.ID)
	}
}

// T3: an unknown identifier (no aliases at all — the realistic shape
// for an in-stream signal, which carries no EntityID today) produces a
// provisional entity rather than an error.
func TestResolve_NoAliasesProducesProvisionalEntityNotError(t *testing.T) {
	r := NewResolver(NewInMemoryStore())
	ctx := context.Background()

	e, err := r.Resolve(ctx, tenantA, "user", nil)
	if err != nil {
		t.Fatalf("Resolve with no aliases returned an error, want a provisional entity: %v", err)
	}
	if e == nil {
		t.Fatal("Resolve returned a nil entity with no error")
	}
	if e.Status != StatusProvisional {
		t.Errorf("Status = %q, want %q", e.Status, StatusProvisional)
	}

	// Two separate unresolvable resolutions must NOT collide into the
	// same entity — there is no identifying information to merge on.
	e2, err := r.Resolve(ctx, tenantA, "user", nil)
	if err != nil {
		t.Fatalf("Resolve with no aliases (second call): %v", err)
	}
	if e2.ID == e.ID {
		t.Fatalf("two independent unresolvable resolutions produced the SAME entity %s — provisional entities must not collapse", e.ID)
	}
}

func TestResolve_ReturnsResolvedStatusWhenAtLeastOneAliasLinked(t *testing.T) {
	r := NewResolver(NewInMemoryStore())
	e, err := r.Resolve(context.Background(), tenantA, "user", []Alias{{Type: AliasUPN, Value: "carol@contoso.com"}})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if e.Status != StatusResolved {
		t.Errorf("Status = %q, want %q", e.Status, StatusResolved)
	}
}

// Merge/ReverseMerge pure-algorithm proof (the Store-agnostic half of
// AC5/T4 — the real-Postgres half lives in the integration test).
func TestMergeAndReverseMerge_RestoresOriginalAliasOwnership(t *testing.T) {
	r := NewResolver(NewInMemoryStore())
	ctx := context.Background()

	eFrom, err := r.Resolve(ctx, tenantA, "user", []Alias{{Type: AliasUPN, Value: "dave@contoso.com"}})
	if err != nil {
		t.Fatalf("Resolve (from): %v", err)
	}
	eInto, err := r.Resolve(ctx, tenantA, "user", []Alias{{Type: AliasEmail, Value: "dave.jones@contoso.com"}})
	if err != nil {
		t.Fatalf("Resolve (into): %v", err)
	}

	mergeID, err := r.Merge(ctx, tenantA, eFrom.ID, eInto.ID, "manual merge: confirmed same person", "admin-1")
	if err != nil {
		t.Fatalf("Merge: %v", err)
	}

	// After the merge, the UPN alias must now resolve to eInto.
	merged, err := r.Resolve(ctx, tenantA, "user", []Alias{{Type: AliasUPN, Value: "dave@contoso.com"}})
	if err != nil {
		t.Fatalf("Resolve after merge: %v", err)
	}
	if merged.ID != eInto.ID {
		t.Fatalf("after merge, UPN resolved to %s, want %s", merged.ID, eInto.ID)
	}

	if err := r.ReverseMerge(ctx, tenantA, mergeID, "admin-1"); err != nil {
		t.Fatalf("ReverseMerge: %v", err)
	}

	// After reversal, the UPN alias must resolve back to eFrom, not eInto.
	reversed, err := r.Resolve(ctx, tenantA, "user", []Alias{{Type: AliasUPN, Value: "dave@contoso.com"}})
	if err != nil {
		t.Fatalf("Resolve after reversal: %v", err)
	}
	if reversed.ID != eFrom.ID {
		t.Fatalf("after reversal, UPN resolved to %s, want the original entity %s", reversed.ID, eFrom.ID)
	}
}
