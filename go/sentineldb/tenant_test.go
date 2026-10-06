package sentineldb

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// No real pool is needed to prove the UUID guard fires before anything
// touches a connection — same reasoning as tenant-context.ts's own test for
// assertTenantIdLooksReal: refusing early is the point, and a nil pool
// proves the guard runs first, not just that it exists.
func TestWithTenantContextRejectsNonUUID(t *testing.T) {
	var nilPool *pgxpool.Pool
	called := false

	_, err := WithTenantContext(context.Background(), nilPool, "not-a-uuid",
		func(ctx context.Context, tx pgx.Tx) (int, error) {
			called = true
			return 0, nil
		},
	)

	var tcErr *TenantContextError
	if !errors.As(err, &tcErr) {
		t.Fatalf("expected a *TenantContextError, got %v (%T)", err, err)
	}
	if called {
		t.Fatal("fn must not run when the tenant id fails the UUID check")
	}
}

func TestWithTenantContextRejectsEmptyString(t *testing.T) {
	var nilPool *pgxpool.Pool
	_, err := WithTenantContext(context.Background(), nilPool, "",
		func(ctx context.Context, tx pgx.Tx) (struct{}, error) {
			return struct{}{}, nil
		},
	)
	var tcErr *TenantContextError
	if !errors.As(err, &tcErr) {
		t.Fatalf("expected a *TenantContextError, got %v (%T)", err, err)
	}
}
