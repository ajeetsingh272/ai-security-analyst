// Package sentineldb is the Go half of the control-plane Postgres access
// layer — the counterpart to packages/db on the TypeScript side, deliberately
// kept mechanism-identical (same role, same session variable, same SET LOCAL
// discipline) because the RLS policies both languages run against don't know
// or care which language issued the SQL (ADR-0008).
package sentineldb

import (
	"context"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
)

const defaultURL = "postgres://sentinel:sentinel@localhost:5434/sentinel"

// NewPool opens a connection pool against the control-plane Postgres,
// authenticating as whatever role POSTGRES_URL names — by convention the
// cluster superuser in local dev (docker-compose.dev.yml's POSTGRES_USER),
// mirroring @sentinel/db's createControlPlanePool on the TypeScript side.
// This pool is NOT tenant-scoped by itself: WithTenantContext is the only
// supported way to run a query RLS actually applies to.
func NewPool(ctx context.Context) (*pgxpool.Pool, error) {
	url := os.Getenv("POSTGRES_URL")
	if url == "" {
		url = defaultURL
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("sentineldb: opening pool: %w", err)
	}
	return pool, nil
}
