//go:build integration

package sentineldb

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// P1-01's cursor store is the first Go code to ever write through RLS —
// everything up to now was TypeScript (P0-05). This proves the Go-side
// WithTenantContext reaches the same guarantee, through the real default
// pool (the cluster superuser, same as docker-compose.dev.yml's
// POSTGRES_USER) rather than a hand-crafted sentinel_app connection — the
// only thing standing between that default and a silent, total RLS bypass
// is the `SET LOCAL ROLE sentinel_app` inside WithTenantContext itself, so
// this test exercises that function, not raw SQL with the switch already
// baked in. Mirrors packages/db/src/__tests__/tenant-isolation.integration.test.ts.
//
// Requires: pnpm dev:stack && pnpm db:migrate. Run via:
//
//	go test -tags=integration ./...
func asAdmin[T any](ctx context.Context, pool *pgxpool.Pool, fn func(tx pgx.Tx) (T, error)) (T, error) {
	var zero T
	tx, err := pool.Begin(ctx)
	if err != nil {
		return zero, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SET LOCAL ROLE "+appRole); err != nil {
		return zero, err
	}
	result, err := fn(tx)
	if err != nil {
		return zero, err
	}
	if err := tx.Commit(ctx); err != nil {
		return zero, err
	}
	return result, nil
}

func TestWithTenantContextEnforcesRLSOnConnectorTables(t *testing.T) {
	ctx := context.Background()

	pool, err := NewPool(ctx)
	if err != nil {
		t.Fatalf("opening pool: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("Postgres not reachable (pnpm dev:stack running?): %v", err)
	}

	tenantA, err := asAdmin(ctx, pool, func(tx pgx.Tx) (string, error) {
		var id string
		err := tx.QueryRow(ctx,
			`INSERT INTO tenants (name, plan) VALUES ('P1-01 go isolation probe A', 'trial') RETURNING id`,
		).Scan(&id)
		return id, err
	})
	if err != nil {
		t.Fatalf("creating tenant A: %v", err)
	}
	tenantB, err := asAdmin(ctx, pool, func(tx pgx.Tx) (string, error) {
		var id string
		err := tx.QueryRow(ctx,
			`INSERT INTO tenants (name, plan) VALUES ('P1-01 go isolation probe B', 'trial') RETURNING id`,
		).Scan(&id)
		return id, err
	})
	if err != nil {
		t.Fatalf("creating tenant B: %v", err)
	}
	t.Cleanup(func() {
		_, _ = asAdmin(ctx, pool, func(tx pgx.Tx) (struct{}, error) {
			_, err := tx.Exec(ctx, "DELETE FROM tenants WHERE id = ANY($1)", []string{tenantA, tenantB})
			return struct{}{}, err
		})
	})

	connA, err := WithTenantContext(ctx, pool, tenantA, func(ctx context.Context, tx pgx.Tx) (string, error) {
		var id string
		err := tx.QueryRow(ctx,
			`INSERT INTO connectors (tenant_id, kind) VALUES ($1, 'm365') RETURNING id`, tenantA,
		).Scan(&id)
		return id, err
	})
	if err != nil {
		t.Fatalf("creating connector for tenant A: %v", err)
	}

	_, err = WithTenantContext(ctx, pool, tenantA, func(ctx context.Context, tx pgx.Tx) (struct{}, error) {
		_, err := tx.Exec(ctx,
			`INSERT INTO connector_cursors (connector_id, tenant_id, stream, cursor)
			 VALUES ($1, $2, 'unified_audit', '{}')`, connA, tenantA,
		)
		return struct{}{}, err
	})
	if err != nil {
		t.Fatalf("creating cursor for tenant A: %v", err)
	}

	// T1: tenant A sees its own row, completely unfiltered — isolation comes
	// entirely from the RLS policy reached through the role switch.
	countAsA, err := WithTenantContext(ctx, pool, tenantA, func(ctx context.Context, tx pgx.Tx) (int, error) {
		var n int
		err := tx.QueryRow(ctx, "SELECT count(*) FROM connector_cursors").Scan(&n)
		return n, err
	})
	if err != nil {
		t.Fatalf("querying as tenant A: %v", err)
	}
	if countAsA != 1 {
		t.Fatalf("expected tenant A to see 1 cursor row, got %d", countAsA)
	}

	// T2: tenant B must see zero rows, not an error and not tenant A's row.
	countAsB, err := WithTenantContext(ctx, pool, tenantB, func(ctx context.Context, tx pgx.Tx) (int, error) {
		var n int
		err := tx.QueryRow(ctx, "SELECT count(*) FROM connector_cursors").Scan(&n)
		return n, err
	})
	if err != nil {
		t.Fatalf("querying as tenant B: %v", err)
	}
	if countAsB != 0 {
		t.Fatalf("expected tenant B to see 0 cursor rows (RLS leak!), got %d", countAsB)
	}

	connectorsAsB, err := WithTenantContext(ctx, pool, tenantB, func(ctx context.Context, tx pgx.Tx) (int, error) {
		var n int
		err := tx.QueryRow(ctx, "SELECT count(*) FROM connectors").Scan(&n)
		return n, err
	})
	if err != nil {
		t.Fatalf("querying connectors as tenant B: %v", err)
	}
	if connectorsAsB != 0 {
		t.Fatalf("expected tenant B to see 0 connectors (RLS leak!), got %d", connectorsAsB)
	}
}
