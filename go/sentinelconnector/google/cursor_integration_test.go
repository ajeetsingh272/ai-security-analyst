//go:build integration

package google

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/jackc/pgx/v5"
)

// T4: "Cursor and checkpoint semantics survive a restart." The
// commit/restore machinery itself (connector_cursors, RLS, ON CONFLICT
// upsert) is entirely generic across connector kind (see
// go/sentinelconnector/cursorstore.go's own doc comment) — this proves it
// holds for a google_workspace connector row specifically, the same way
// m365's own scheduler integration tests prove it for 'm365'. "Restart" is
// simulated by discarding the first PostgresCursorStore instance and
// querying with a brand new one — an in-process struct is not what
// persists the value, the Postgres row is.
//
// Requires: pnpm dev:stack && pnpm db:migrate. Run via:
//
//	go test -tags=integration ./go/sentinelconnector/google/...
func TestCursor_SurvivesRestart(t *testing.T) {
	ctx := context.Background()
	pool := withIntegrationPool(t)

	tenantID := seedTenant(t, ctx, pool, "P7-01 go cursor restart probe")
	connectorRowID, err := sentineldb.WithTenantContext(ctx, pool, tenantID, func(ctx context.Context, tx pgx.Tx) (string, error) {
		var id string
		err := tx.QueryRow(ctx,
			`INSERT INTO connectors (tenant_id, kind, status) VALUES ($1, 'google_workspace', 'healthy') RETURNING id`,
			tenantID,
		).Scan(&id)
		return id, err
	})
	if err != nil {
		t.Fatalf("seeding connectors row: %v", err)
	}

	store1 := sentinelconnector.NewPostgresCursorStore(pool)
	state := cursorState{LastEventTime: "2024-01-01T00:05:00.000Z", LastUniqueQualifier: "evt-2"}
	cur, err := json.Marshal(state)
	if err != nil {
		t.Fatalf("marshalling cursor: %v", err)
	}
	if err := store1.Commit(ctx, tenantID, connectorRowID, "login", sentinelconnector.Cursor(cur)); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	// Brand new store instance — the only thing simulating "restart" is
	// discarding store1 and never touching it again; store2 has no shared
	// in-memory state with it whatsoever.
	store2 := sentinelconnector.NewPostgresCursorStore(pool)
	gotCur, ok, err := store2.Get(ctx, tenantID, connectorRowID, "login")
	if err != nil {
		t.Fatalf("Get after restart: %v", err)
	}
	if !ok {
		t.Fatal("expected a committed cursor to be found after restart")
	}
	var gotState cursorState
	if err := json.Unmarshal(gotCur, &gotState); err != nil {
		t.Fatalf("decoding restored cursor: %v", err)
	}
	if gotState != state {
		t.Fatalf("cursor after restart mismatch: got %+v want %+v", gotState, state)
	}

	// A different stream (applicationName) for the SAME connector row must
	// not have been affected — each stream's checkpoint is independent.
	_, ok, err = store2.Get(ctx, tenantID, connectorRowID, "drive")
	if err != nil {
		t.Fatalf("Get for an uncommitted stream: %v", err)
	}
	if ok {
		t.Fatal("expected no committed cursor for a stream that was never committed")
	}
}
