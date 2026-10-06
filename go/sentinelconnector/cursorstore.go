package sentinelconnector

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// CursorStorer is what the scheduler actually depends on — an interface,
// not PostgresCursorStore directly, so P1-01's T1/T2 (unit tests: cursor
// advances only after ack; a connector error does not advance it) can prove
// the scheduler's orchestration logic in isolation from a running Postgres,
// the same way Publisher/InMemoryPublisher let it run without a broker.
type CursorStorer interface {
	Get(ctx context.Context, tenantID, connectorID, stream string) (Cursor, bool, error)
	Commit(ctx context.Context, tenantID, connectorID, stream string, cur Cursor) error
}

// PostgresCursorStore persists and retrieves per-tenant, per-connector,
// per-stream checkpoints in Postgres, through sentineldb.WithTenantContext —
// the same RLS-enforcing path every other tenant-scoped write in this
// system uses (ADR-0008), reached from Go for the first time in P1-01.
type PostgresCursorStore struct {
	pool *pgxpool.Pool
}

func NewPostgresCursorStore(pool *pgxpool.Pool) *PostgresCursorStore {
	return &PostgresCursorStore{pool: pool}
}

type cursorResult struct {
	cur Cursor
	ok  bool
}

// Get returns the stored cursor for (connectorID, stream), or ok=false if
// none has been committed yet — a brand new connector's first run.
func (s *PostgresCursorStore) Get(ctx context.Context, tenantID, connectorID, stream string) (Cursor, bool, error) {
	r, err := sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (cursorResult, error) {
		var raw []byte
		err := tx.QueryRow(ctx,
			`SELECT cursor FROM connector_cursors WHERE connector_id = $1 AND stream = $2`,
			connectorID, stream,
		).Scan(&raw)
		if errors.Is(err, pgx.ErrNoRows) {
			return cursorResult{}, nil
		}
		if err != nil {
			return cursorResult{}, err
		}
		return cursorResult{cur: Cursor(raw), ok: true}, nil
	})
	if err != nil {
		return nil, false, fmt.Errorf("sentinelconnector: reading cursor: %w", err)
	}
	return r.cur, r.ok, nil
}

// Commit upserts the cursor for (connectorID, stream) — called ONLY after
// the scheduler's Publisher.Publish has returned successfully (ADR-0010).
// This function has no opinion about that ordering; it writes whatever it's
// given, when it's given it. The scheduler owns the ordering, not this type.
func (s *PostgresCursorStore) Commit(ctx context.Context, tenantID, connectorID, stream string, cur Cursor) error {
	_, err := sentineldb.WithTenantContext(ctx, s.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (struct{}, error) {
		_, execErr := tx.Exec(ctx,
			`INSERT INTO connector_cursors (connector_id, tenant_id, stream, cursor, updated_at)
			 VALUES ($1, $2, $3, $4, now())
			 ON CONFLICT (connector_id, stream)
			 DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()`,
			connectorID, tenantID, stream, []byte(cur),
		)
		return struct{}{}, execErr
	})
	if err != nil {
		return fmt.Errorf("sentinelconnector: committing cursor: %w", err)
	}
	return nil
}

// InMemoryCursorStore is a CursorStorer test double — no Postgres, no RLS,
// just a map. Used by the scheduler's unit tests (T1/T2); the integration
// tests (T3/T4) use PostgresCursorStore against the real database, because
// those specifically need to prove behaviour under real transactional
// persistence and real process-signal timing.
type InMemoryCursorStore struct {
	mu      sync.Mutex
	cursors map[string]Cursor // key: tenantID + "/" + connectorID + "/" + stream
}

func NewInMemoryCursorStore() *InMemoryCursorStore {
	return &InMemoryCursorStore{cursors: make(map[string]Cursor)}
}

func (s *InMemoryCursorStore) key(tenantID, connectorID, stream string) string {
	return tenantID + "/" + connectorID + "/" + stream
}

func (s *InMemoryCursorStore) Get(_ context.Context, tenantID, connectorID, stream string) (Cursor, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, ok := s.cursors[s.key(tenantID, connectorID, stream)]
	return cur, ok, nil
}

func (s *InMemoryCursorStore) Commit(_ context.Context, tenantID, connectorID, stream string, cur Cursor) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cursors[s.key(tenantID, connectorID, stream)] = cur
	return nil
}
