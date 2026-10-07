package entity

import (
	"context"
	"fmt"
	"sync"

	"github.com/google/uuid"
)

// InMemoryStore is a Store test double — no Postgres, just maps —
// mirroring go/sentinelconnector.InMemoryCursorStore's own role for
// the scheduler's unit tests. Used by T1-T3; T4 (the merge-reversal
// integration test) and the latency benchmark use PostgresStore
// against the real database, since those specifically need to prove
// behaviour under real RLS and real transactional persistence.
type InMemoryStore struct {
	mu sync.Mutex

	// aliasOwner: tenantID -> Alias -> entityID.
	aliasOwner map[string]map[Alias]string
	entities   map[string]*Entity // entityID -> entity (global map; entityID is already globally unique)
	merges     map[string]*MergeRecord
	// aliasesByEntity: entityID -> the aliases currently linked to it,
	// needed so MergeEntities can snapshot exactly what it moved, the
	// same thing PostgresStore does with a real query.
	aliasesByEntity map[string][]aliasRecord
}

type aliasRecord struct {
	id    string
	alias Alias
}

func NewInMemoryStore() *InMemoryStore {
	return &InMemoryStore{
		aliasOwner:      map[string]map[Alias]string{},
		entities:        map[string]*Entity{},
		merges:          map[string]*MergeRecord{},
		aliasesByEntity: map[string][]aliasRecord{},
	}
}

func (s *InMemoryStore) FindEntitiesByAliases(_ context.Context, tenantID string, aliases []Alias) (map[Alias]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[Alias]string{}
	owners := s.aliasOwner[tenantID]
	for _, a := range aliases {
		if id, ok := owners[a]; ok {
			out[a] = id
		}
	}
	return out, nil
}

func (s *InMemoryStore) CreateEntity(_ context.Context, _, entityType, status string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := uuid.NewString()
	s.entities[id] = &Entity{ID: id, EntityType: entityType, Status: status}
	return id, nil
}

func (s *InMemoryStore) CreateEntityWithAliases(ctx context.Context, tenantID, entityType, status string, aliases []Alias) (string, error) {
	s.mu.Lock()
	id := uuid.NewString()
	s.entities[id] = &Entity{ID: id, EntityType: entityType, Status: status}
	s.mu.Unlock()
	if err := s.LinkAliases(ctx, tenantID, id, aliases); err != nil {
		return "", err
	}
	return id, nil
}

func (s *InMemoryStore) LinkAliases(_ context.Context, tenantID, entityID string, aliases []Alias) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.entities[entityID]; !ok {
		return fmt.Errorf("entity %s does not exist", entityID)
	}
	owners, ok := s.aliasOwner[tenantID]
	if !ok {
		owners = map[Alias]string{}
		s.aliasOwner[tenantID] = owners
	}
	for _, a := range aliases {
		if existing, taken := owners[a]; taken && existing != entityID {
			return fmt.Errorf("alias %+v already linked to a different entity %s", a, existing)
		}
		owners[a] = entityID
		s.aliasesByEntity[entityID] = append(s.aliasesByEntity[entityID], aliasRecord{id: uuid.NewString(), alias: a})
	}
	return nil
}

func (s *InMemoryStore) MergeEntities(_ context.Context, tenantID, fromEntityID, intoEntityID, reason, actorType, actorID string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	owners := s.aliasOwner[tenantID]
	moved := s.aliasesByEntity[fromEntityID]
	movedIDs := make([]string, 0, len(moved))
	for _, rec := range moved {
		owners[rec.alias] = intoEntityID
		movedIDs = append(movedIDs, rec.id)
	}
	s.aliasesByEntity[intoEntityID] = append(s.aliasesByEntity[intoEntityID], moved...)
	delete(s.aliasesByEntity, fromEntityID)

	if e, ok := s.entities[intoEntityID]; ok && len(moved) > 0 {
		e.Status = StatusResolved
	}

	mergeID := uuid.NewString()
	s.merges[mergeID] = &MergeRecord{
		ID: mergeID, FromEntityID: fromEntityID, IntoEntityID: intoEntityID,
		MovedAliasIDs: movedIDs, Reason: reason, ActorType: actorType, ActorID: actorID,
	}
	return mergeID, nil
}

func (s *InMemoryStore) ReverseMerge(_ context.Context, _, mergeID, reversedBy string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	m, ok := s.merges[mergeID]
	if !ok {
		return fmt.Errorf("merge %s not found", mergeID)
	}
	if m.ReversedAt != nil {
		return fmt.Errorf("merge %s already reversed", mergeID)
	}

	movedSet := make(map[string]bool, len(m.MovedAliasIDs))
	for _, id := range m.MovedAliasIDs {
		movedSet[id] = true
	}

	var stillOnInto []aliasRecord
	var movingBack []aliasRecord
	for _, rec := range s.aliasesByEntity[m.IntoEntityID] {
		if movedSet[rec.id] {
			movingBack = append(movingBack, rec)
		} else {
			stillOnInto = append(stillOnInto, rec)
		}
	}
	s.aliasesByEntity[m.IntoEntityID] = stillOnInto
	s.aliasesByEntity[m.FromEntityID] = append(s.aliasesByEntity[m.FromEntityID], movingBack...)

	// aliasOwner isn't tenant-keyed in this lookup (reversal doesn't
	// receive tenantID in the signature it's tested against here
	// since the caller already knows it) — walk every tenant's own map
	// defensively; in practice a merge only ever touches one tenant's
	// aliases.
	for _, owners := range s.aliasOwner {
		for _, rec := range movingBack {
			if owners[rec.alias] == m.IntoEntityID {
				owners[rec.alias] = m.FromEntityID
			}
		}
	}

	now := "reversed"
	m.ReversedAt = &now
	m.ReversedBy = &reversedBy
	return nil
}
