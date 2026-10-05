package sentineldb

import (
	"context"
	"fmt"
	"regexp"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The role every tenant-scoped query actually runs as, regardless of which
// role the pool authenticated with — the Go-side mirror of
// packages/db/src/tenant-context.ts's APP_ROLE. A fixed literal, never
// derived from input: SET LOCAL ROLE does not accept a parameterised
// identifier, so this is interpolated directly, which is only safe because
// it is a constant.
const appRole = "sentinel_app"

// Minimal UUID shape check — not full RFC 4122 validation, just "this cannot
// possibly be a UUID" rejected early, before it reaches a SQL parameter.
// Same pattern as tenant-context.ts's UUID_LIKE.
var uuidLike = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// TenantContextError mirrors packages/db's TenantContextError — a distinct
// type so a caller can tell "no/invalid tenant context" apart from an
// ordinary query failure.
type TenantContextError struct {
	msg string
}

func (e *TenantContextError) Error() string { return e.msg }

// WithTenantContext runs fn inside a transaction with app.tenant_id set and
// the connection's role switched to sentinel_app for the transaction's
// duration — the exact mechanism packages/db/src/tenant-context.ts uses,
// deliberately kept identical rather than reinvented, because the RLS
// policies this enforces are language-agnostic: they check
// current_setting('app.tenant_id') and the connecting role, regardless of
// which language issued the SQL. A pool default-connects as the cluster
// superuser (POSTGRES_USER in docker-compose.dev.yml), and superusers bypass
// RLS unconditionally — without the role switch below, every query here
// would silently run with RLS disabled, exactly the bug P0-05 found and
// fixed on the TypeScript side (SET LOCAL ROLE missing from
// TenantScopedRepository.withTransaction).
//
// SET LOCAL, not SET — SET is session-scoped, and pgxpool reuses physical
// connections across callers; a session-scoped value would leak onto the
// next caller handed the same connection, who could be a different tenant
// entirely. SET LOCAL is scoped to the transaction and is discarded
// automatically at COMMIT or ROLLBACK, so there is no connection state to
// leak regardless of what the pool does with the connection next.
func WithTenantContext[T any](
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID string,
	fn func(ctx context.Context, tx pgx.Tx) (T, error),
) (T, error) {
	var zero T
	if !uuidLike.MatchString(tenantID) {
		return zero, &TenantContextError{
			msg: fmt.Sprintf(
				"sentineldb: %q is not a UUID. Refusing to establish a tenant context "+
					"with a value that cannot be a real tenant id — this is almost always "+
					"a bug upstream, and proceeding would make that bug someone else's "+
					"zero-rows mystery later.", tenantID,
			),
		}
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return zero, fmt.Errorf("sentineldb: beginning transaction: %w", err)
	}
	// Rollback is a no-op against an already-committed transaction (pgx
	// returns pgx.ErrTxClosed, deliberately ignored here) — this is just the
	// safety net for every early-return path above a successful Commit.
	defer func() { _ = tx.Rollback(ctx) }()

	// This line is the whole guarantee — see the function comment.
	if _, err := tx.Exec(ctx, "SET LOCAL ROLE "+appRole); err != nil {
		return zero, fmt.Errorf("sentineldb: switching role: %w", err)
	}
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		return zero, fmt.Errorf("sentineldb: setting tenant context: %w", err)
	}

	result, err := fn(ctx, tx)
	if err != nil {
		return zero, err
	}
	if err := tx.Commit(ctx); err != nil {
		return zero, fmt.Errorf("sentineldb: committing transaction: %w", err)
	}
	return result, nil
}
