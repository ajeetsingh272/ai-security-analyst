package entity

import (
	"context"
	"fmt"
	"sort"
)

// actorSystem names the resolver itself as the actor for an auto-merge
// — ADR-0011's own decision: co-occurrence is evidence a human never
// had to assert, so the audit trail should say exactly that, not
// attribute it to whichever user's own action happened to produce the
// triggering signal.
const actorSystem = "entity-resolver"

// Resolver is the pure algorithm — AC1-AC3's own resolution logic,
// against the narrow Store boundary rather than a concrete Postgres
// client, so T1-T3 (unit tests) can run it against InMemoryStore with
// no database at all, the same "pure core, swappable I/O shell" split
// services/detect/internal/worker.evaluate already uses.
type Resolver struct {
	store Store
}

func NewResolver(store Store) *Resolver {
	return &Resolver{store: store}
}

// FastResolver is an OPTIONAL optimization a Store may implement — the
// entire find-or-create-or-merge-and-link sequence in a single
// transaction. AC4's <5ms p99 budget measured directly that even two
// SEPARATE transactions (a lookup, then a create-or-merge), each
// paying its own BEGIN/SET ROLE/set_config/COMMIT round trips, is not
// reliably enough: p99 only cleared budget once the common "every
// alias is brand new" case collapsed to one transaction. Resolver uses
// this when the Store provides it; InMemoryStore does not, since
// latency is not a concern for unit tests and the step-by-step path
// below exercises the identical decision algorithm (resolver_test.go's
// own tests are this method's real coverage either way).
type FastResolver interface {
	ResolveFast(ctx context.Context, tenantID, entityType string, aliases []Alias) (*Entity, error)
}

// Resolve finds-or-creates the canonical entity for the given set of
// aliases — all known simultaneously, from one signal's own underlying
// event. ADR-0011's own decision: aliases seen TOGETHER that already
// point at more than one existing entity is itself the evidence they
// are the same real entity, and this method auto-merges them rather
// than returning an ambiguous result.
//
// aliases may be empty (AC3/T3: an unidentifiable signal) — this is
// never an error, always a freshly created, provisional entity.
func (r *Resolver) Resolve(ctx context.Context, tenantID, entityType string, aliases []Alias) (*Entity, error) {
	if fr, ok := r.store.(FastResolver); ok && len(aliases) > 0 {
		return fr.ResolveFast(ctx, tenantID, entityType, aliases)
	}

	if len(aliases) == 0 {
		id, err := r.store.CreateEntity(ctx, tenantID, entityType, StatusProvisional)
		if err != nil {
			return nil, fmt.Errorf("entity: creating provisional entity: %w", err)
		}
		return &Entity{ID: id, EntityType: entityType, Status: StatusProvisional}, nil
	}

	found, err := r.store.FindEntitiesByAliases(ctx, tenantID, aliases)
	if err != nil {
		return nil, fmt.Errorf("entity: looking up aliases: %w", err)
	}

	canonicalID, err := r.settle(ctx, tenantID, entityType, aliases, found)
	if err != nil {
		return nil, err
	}
	return &Entity{ID: canonicalID, EntityType: entityType, Status: StatusResolved}, nil
}

// settle decides which entity the resolved aliases should end up on,
// performs whatever create/merge that requires, and links every alias
// that isn't already linked — all of it. Collapsed into one method
// (rather than Resolve doing its own separate link step afterward)
// specifically for AC4's <5ms p99 budget: the dominant real-world case
// — every alias in this call is brand new — now takes exactly ONE
// extra transaction (create-with-aliases) on top of the initial
// lookup, not two (a bare create, then a separate link). Measured
// directly: this is what took p99 from ~8ms to comfortably under
// budget (see postgres_store_integration_test.go).
func (r *Resolver) settle(ctx context.Context, tenantID, entityType string, aliases []Alias, found map[Alias]string) (string, error) {
	distinct := distinctEntityIDs(found)

	switch len(distinct) {
	case 0:
		// None of these aliases have ever been seen — a brand new,
		// fully-identified entity, created with every alias attached
		// in the same transaction.
		id, err := r.store.CreateEntityWithAliases(ctx, tenantID, entityType, StatusResolved, aliases)
		if err != nil {
			return "", fmt.Errorf("entity: creating resolved entity: %w", err)
		}
		return id, nil

	case 1:
		canonicalID := distinct[0]
		if unseen := unseenAliases(aliases, found); len(unseen) > 0 {
			if err := r.store.LinkAliases(ctx, tenantID, canonicalID, unseen); err != nil {
				return "", fmt.Errorf("entity: linking new aliases: %w", err)
			}
		}
		return canonicalID, nil

	default:
		// Co-occurring aliases currently point at MORE than one
		// entity — ADR-0011's own merge trigger. Sorted for a
		// deterministic "which one survives" choice, not because the
		// order carries any other meaning.
		sort.Strings(distinct)
		canonicalID := distinct[0]
		for _, other := range distinct[1:] {
			if _, err := r.store.MergeEntities(ctx, tenantID, other, canonicalID,
				"co-occurring aliases resolved to one entity", "system", actorSystem); err != nil {
				return "", fmt.Errorf("entity: auto-merging %s into %s: %w", other, canonicalID, err)
			}
		}
		if unseen := unseenAliases(aliases, found); len(unseen) > 0 {
			if err := r.store.LinkAliases(ctx, tenantID, canonicalID, unseen); err != nil {
				return "", fmt.Errorf("entity: linking new aliases after merge: %w", err)
			}
		}
		return canonicalID, nil
	}
}

func unseenAliases(aliases []Alias, found map[Alias]string) []Alias {
	var unseen []Alias
	for _, a := range aliases {
		if _, ok := found[a]; !ok {
			unseen = append(unseen, a)
		}
	}
	return unseen
}

func distinctEntityIDs(found map[Alias]string) []string {
	seen := make(map[string]bool, len(found))
	var out []string
	for _, id := range found {
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

// Merge explicitly merges fromEntityID into intoEntityID — the
// human-initiated counterpart to Resolve's own automatic merge, for a
// future admin-facing "these are actually the same person" action.
// Returns the new entity_merges row's id.
func (r *Resolver) Merge(ctx context.Context, tenantID, fromEntityID, intoEntityID, reason, actorID string) (string, error) {
	mergeID, err := r.store.MergeEntities(ctx, tenantID, fromEntityID, intoEntityID, reason, "human", actorID)
	if err != nil {
		return "", fmt.Errorf("entity: merging %s into %s: %w", fromEntityID, intoEntityID, err)
	}
	return mergeID, nil
}

// ReverseMerge undoes a previously recorded merge (AC5/T4) — see
// Store.ReverseMerge's own doc comment for the exact, bounded semantics.
func (r *Resolver) ReverseMerge(ctx context.Context, tenantID, mergeID, reversedBy string) error {
	if err := r.store.ReverseMerge(ctx, tenantID, mergeID, reversedBy); err != nil {
		return fmt.Errorf("entity: reversing merge %s: %w", mergeID, err)
	}
	return nil
}
