// Package cluster is P3-02: signals sharing an entity within a sliding
// window become one Case. Deliberately decoupled from
// go/sentinelsignal.Signal's own wire shape (this package's own Signal
// is a small, independent struct) for the same reason
// services/correlate/internal/entity stays decoupled from it — whatever
// reads the `signals` topic (cmd/correlate's own consumer loop) is
// responsible for translating a wire Signal into this package's input,
// keeping both packages usable from anywhere, not just one Kafka
// consumer.
//
// cases/case_transitions (db/postgres/migrations/0001_foundation.sql)
// already have the right shape for this ticket and are left untouched
// — P3-03 ("Case lifecycle and append-only transition log") owns any
// further evolution of those two tables. This package only ever writes
// `open` and `closed` transitions (a case's quiet-period expiry), never
// the fuller triaging/investigating/awaiting_approval/actioned/dismissed
// states P3-03 and later tickets own.
package cluster

import (
	"context"
	"time"
)

// Signal is the minimal shape Clusterer needs from a real signal —
// see the package doc comment for why this is not
// go/sentinelsignal.Signal directly.
type Signal struct {
	DedupeKey  string
	SignalID   string
	RuleID     string
	EntityType string
	EntityID   string
	Severity   string
	EventIDs   []string
	// DetectedAt is the signal's own EVENT time — every windowing
	// decision in this package uses this, never wall-clock processing
	// time, which is what AC5/T4 ("clustering is deterministic —
	// identical input produces an identical case set") actually
	// depends on: replaying the same signals faster or slower must
	// never change which case they land in.
	DetectedAt time.Time
}

// Store is the persistence boundary Clusterer depends on — the same
// "interface at the consumer" pattern
// services/correlate/internal/entity.Store and
// services/detect/internal/suppression.Checker already use in this
// repo, so T1-T4 (unit tests) run against an in-memory double with no
// database at all.
type Store interface {
	// FindOpenCaseForEntity returns the open case (window_end IS NULL)
	// for this tenant+entity whose most recent signal is still within
	// windowDuration of asOf — i.e. "would a signal arriving at asOf
	// still join it". found=false if no open case qualifies, whether
	// because none exists at all or because the only one's window has
	// already lapsed (AC2/T2's own "outside the window" case).
	FindOpenCaseForEntity(ctx context.Context, tenantID, entityType, entityID string, windowDuration time.Duration, asOf time.Time) (caseID string, found bool, err error)

	// CreateCaseWithSignal opens a new case containing exactly this
	// one signal, atomically (the case row, its 'open' transition, and
	// the case_signals row).
	CreateCaseWithSignal(ctx context.Context, tenantID string, sig Signal) (caseID string, err error)

	// AddSignalToCase adds sig to an existing case. added=false
	// (not an error) if this exact signal (by DedupeKey) was already
	// present — AC5/T4's own idempotent-replay guarantee.
	AddSignalToCase(ctx context.Context, tenantID, caseID string, sig Signal) (added bool, err error)

	// CloseQuietCases closes (sets window_end, records a 'closed'
	// transition) every open case for this tenant whose most recent
	// signal is more than quietPeriod before asOf (AC4).
	CloseQuietCases(ctx context.Context, tenantID string, quietPeriod time.Duration, asOf time.Time) (closed int, err error)
}

// DefaultWindow is AC1's own "default 60-minute sliding window".
const DefaultWindow = 60 * time.Minute

// Clusterer is the pure branching logic (AC1-AC3) against the narrow
// Store boundary — the same "pure core, swappable I/O shell" split
// services/detect/internal/worker.evaluate and
// services/correlate/internal/entity.Resolver already use.
type Clusterer struct {
	store  Store
	window time.Duration
}

// NewClusterer builds a Clusterer with a per-rule window override
// (AC1's "default 60-minute... with per-rule override") — callers that
// want the default pass cluster.DefaultWindow explicitly, so the
// default is never implicit inside this type.
func NewClusterer(store Store, window time.Duration) *Clusterer {
	return &Clusterer{store: store, window: window}
}

// Cluster assigns sig to a case: joining an existing open one for the
// same entity if one is still within the window (AC2/AC3), or opening
// a new one. A signal with no entity at all (EntityType/EntityID both
// "" — e.g. an in-stream signal whose event carried no recognisable
// identity field) has nothing to cluster on, so it always opens its
// own standalone case — the same "retained, never discarded" principle
// P3-01's own provisional entities already establish, applied here to
// signals instead.
func (c *Clusterer) Cluster(ctx context.Context, tenantID string, sig Signal) (caseID string, err error) {
	if sig.EntityType == "" || sig.EntityID == "" {
		return c.store.CreateCaseWithSignal(ctx, tenantID, sig)
	}

	existingID, found, err := c.store.FindOpenCaseForEntity(ctx, tenantID, sig.EntityType, sig.EntityID, c.window, sig.DetectedAt)
	if err != nil {
		return "", err
	}
	if found {
		if _, err := c.store.AddSignalToCase(ctx, tenantID, existingID, sig); err != nil {
			return "", err
		}
		return existingID, nil
	}

	return c.store.CreateCaseWithSignal(ctx, tenantID, sig)
}

// CloseQuietCases is AC4's own "a case closes its window after a
// configurable quiet period" — a thin pass-through, kept on Clusterer
// rather than called directly on Store so cmd/correlate's own
// consumer only ever depends on this package's exported surface.
func (c *Clusterer) CloseQuietCases(ctx context.Context, tenantID string, quietPeriod time.Duration, asOf time.Time) (int, error) {
	return c.store.CloseQuietCases(ctx, tenantID, quietPeriod, asOf)
}
