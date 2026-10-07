package cluster

import (
	"context"
	"sync"
	"time"

	"github.com/google/uuid"
)

type caseRecord struct {
	id         string
	entityType string
	entityID   string
	open       bool
	signals    []Signal // in arrival order; also doubles as the dedupe set
}

// InMemoryStore is a Store test double — no Postgres, just maps —
// mirroring entity.InMemoryStore's own role for P3-01's unit tests.
// Used by T1-T4; T5 (the real BEC-scenario integration test) uses
// PostgresStore against the real database.
type InMemoryStore struct {
	mu    sync.Mutex
	cases map[string]*caseRecord // tenantID+":"+caseID -> record, but keyed flatly by caseID since ids are globally unique
}

func NewInMemoryStore() *InMemoryStore {
	return &InMemoryStore{cases: map[string]*caseRecord{}}
}

func (s *InMemoryStore) FindOpenCaseForEntity(_ context.Context, tenantID, entityType, entityID string, windowDuration time.Duration, asOf time.Time) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var bestID string
	var bestLast time.Time
	found := false
	for id, c := range s.cases {
		if !c.open || c.entityType != entityType || c.entityID != entityID {
			continue
		}
		last := lastDetected(c.signals)
		if asOf.Sub(last) > windowDuration {
			continue // this case's window has already lapsed as of asOf
		}
		if !found || last.After(bestLast) {
			bestID, bestLast, found = id, last, true
		}
	}
	return bestID, found, nil
}

func (s *InMemoryStore) CreateCaseWithSignal(_ context.Context, _ string, sig Signal) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Mirrors PostgresStore's own idempotent-replay check: a signal
	// whose original case has since closed (no longer an open
	// candidate FindOpenCaseForEntity would return) still already has
	// a home — return it rather than creating an orphaned duplicate.
	for id, c := range s.cases {
		for _, existing := range c.signals {
			if existing.DedupeKey == sig.DedupeKey {
				return id, nil
			}
		}
	}

	id := uuid.NewString()
	s.cases[id] = &caseRecord{id: id, entityType: sig.EntityType, entityID: sig.EntityID, open: true, signals: []Signal{sig}}
	return id, nil
}

func (s *InMemoryStore) AddSignalToCase(_ context.Context, _, caseID string, sig Signal) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.cases[caseID]
	if !ok {
		return false, nil
	}
	for _, existing := range c.signals {
		if existing.DedupeKey == sig.DedupeKey {
			return false, nil // AC5/T4: already present, idempotent no-op
		}
	}
	c.signals = append(c.signals, sig)
	return true, nil
}

func (s *InMemoryStore) CloseQuietCases(_ context.Context, _ string, quietPeriod time.Duration, asOf time.Time) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	closed := 0
	for _, c := range s.cases {
		if !c.open {
			continue
		}
		if asOf.Sub(lastDetected(c.signals)) > quietPeriod {
			c.open = false
			closed++
		}
	}
	return closed, nil
}

func lastDetected(signals []Signal) time.Time {
	var last time.Time
	for _, s := range signals {
		if s.DetectedAt.After(last) {
			last = s.DetectedAt
		}
	}
	return last
}
