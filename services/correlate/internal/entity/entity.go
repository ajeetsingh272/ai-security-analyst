// Package entity is P3-01 (ADR-0011): resolving a signal's own raw
// identifiers — a UPN, an Azure AD object id, a primary or proxy email
// address — to one canonical, tenant-scoped entity, so correlation
// (P3-02) sees "the same person" once, not three times because three
// different M365 operations each logged a different identifier for
// them.
//
// Deliberately decoupled from go/sentinelsignal.Signal's own wire
// shape: this package only ever sees tenantID/entityType/[]Alias, plain
// strings, not a Signal. Whatever reads the signals topic (P3-02's own
// consumer loop) is responsible for extracting a signal's aliases from
// its underlying event before calling Resolve — keeping this package
// usable from anywhere, not just one Kafka consumer.
package entity

import "context"

// AliasType is deliberately a free-form string, not a closed Go enum —
// matching every other "kind of thing a rule/event names" convention in
// this repo (sigmac's own Engine, windowed's entityTypeFromGroupField
// output) rather than inventing the one closed type in an otherwise
// open-vocabulary system.
type AliasType string

const (
	AliasUPN       AliasType = "upn"
	AliasObjectID  AliasType = "object_id"
	AliasEmail     AliasType = "email"
	AliasProxyAddr AliasType = "proxy_address"
	AliasUnknown   AliasType = "unknown"
)

// Alias is one identifier known for an entity, in one specific format.
type Alias struct {
	Type  AliasType
	Value string
}

const (
	StatusProvisional = "provisional"
	StatusResolved    = "resolved"
)

// Entity is the canonical resolution target — AC3's own "retained as
// provisional rather than discarded" means every resolution call
// returns one of these, never an error for lack of identifying
// information.
type Entity struct {
	ID         string
	EntityType string
	Status     string // StatusProvisional | StatusResolved
}

// MergeRecord is one entity_merges row — ADR-0011's own dedicated audit
// trail for AC5 ("an alias merge is reversible and audited").
type MergeRecord struct {
	ID            string
	FromEntityID  string
	IntoEntityID  string
	MovedAliasIDs []string
	Reason        string
	ActorType     string // "human" | "system"
	ActorID       string
	ReversedAt    *string // RFC3339, nil if never reversed
	ReversedBy    *string
}

// Store is the persistence boundary Resolver depends on — narrow
// enough that a unit test can use an in-memory fake (T1-T3) while
// production and the integration test (T4) use a real Postgres-backed
// one, the same "interface at the consumer" pattern
// services/detect/internal/suppression.Checker and
// go/sentinelconnector.CursorStorer already use in this repo.
type Store interface {
	// FindEntitiesByAliases looks up every given alias in one round
	// trip (AC4's own <5ms p99 budget depends on this staying O(1)
	// round trips, not O(len(aliases))). An alias absent from the
	// returned map has never been seen before.
	FindEntitiesByAliases(ctx context.Context, tenantID string, aliases []Alias) (map[Alias]string, error)

	// CreateEntity returns the new entity's id.
	CreateEntity(ctx context.Context, tenantID, entityType, status string) (entityID string, err error)

	// CreateEntityWithAliases creates a new entity and links every
	// given alias to it in ONE round trip — the hot-path optimization
	// AC4's <5ms p99 budget depends on for the dominant case (every
	// alias in a resolve call is brand new), avoiding the separate
	// CreateEntity + LinkAliases round trips that case would otherwise
	// cost.
	CreateEntityWithAliases(ctx context.Context, tenantID, entityType, status string, aliases []Alias) (entityID string, err error)

	// LinkAliases attaches every given alias to entityID, in one round
	// trip. Callers must only pass aliases FindEntitiesByAliases has
	// already confirmed are unseen — linking an alias already owned by
	// a DIFFERENT entity is a bug in the caller (Resolver), not
	// something this method silently resolves by overwriting.
	LinkAliases(ctx context.Context, tenantID, entityID string, aliases []Alias) error

	// MergeEntities moves every alias currently linked to
	// fromEntityID onto intoEntityID and records the merge, atomically
	// — the moved-alias-id set is computed and snapshotted INSIDE this
	// call (never passed in), so it can never race with a concurrent
	// LinkAliases. Returns the new entity_merges row's id.
	MergeEntities(ctx context.Context, tenantID, fromEntityID, intoEntityID, reason, actorType, actorID string) (mergeID string, err error)

	// ReverseMerge undoes exactly the alias moves the named merge
	// performed — moving those specific alias ids back to
	// fromEntityID, regardless of who currently owns them (a later,
	// unrelated merge may have moved the TARGET entity's aliases
	// further; this reversal never touches those).
	ReverseMerge(ctx context.Context, tenantID, mergeID, reversedBy string) error
}
