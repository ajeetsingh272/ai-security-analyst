package sentinelconnector

import (
	"context"
	"fmt"
	"sync"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// HealthRecorder persists the outcome of a cycle onto the connectors table's
// own status/last_error/last_sync_at columns (AC4: "per-connector health is
// exposed... and surfaced through the API"). This is the mechanism and the
// data layer; the actual HTTP endpoint that reads it for a dashboard is
// P1-11's ticket ("Ingest observability — lag, EPS and connector health"),
// which depends on P1-07 landing first — apps/api has no running server to
// put such an endpoint on yet either (P0-09's own closing notes). P1-01
// makes the data correct and queryable; it does not build the query surface.
type HealthRecorder interface {
	RecordOutcome(ctx context.Context, tenantID, connectorRowID string, success bool, errMsg string) error
}

// PostgresHealthRecorder writes through sentineldb.WithTenantContext, same
// as every other tenant-scoped write in this package.
type PostgresHealthRecorder struct {
	pool *pgxpool.Pool
}

func NewPostgresHealthRecorder(pool *pgxpool.Pool) *PostgresHealthRecorder {
	return &PostgresHealthRecorder{pool: pool}
}

func (r *PostgresHealthRecorder) RecordOutcome(ctx context.Context, tenantID, connectorRowID string, success bool, errMsg string) error {
	status := "healthy"
	var lastErr any
	if !success {
		status = "error"
		lastErr = errMsg
	}
	_, err := sentineldb.WithTenantContext(ctx, r.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (struct{}, error) {
		_, execErr := tx.Exec(ctx,
			`UPDATE connectors SET status = $1, last_error = $2, last_sync_at = now() WHERE id = $3`,
			status, lastErr, connectorRowID,
		)
		return struct{}{}, execErr
	})
	if err != nil {
		return fmt.Errorf("sentinelconnector: recording health: %w", err)
	}
	return nil
}

// InMemoryHealthRecorder is a HealthRecorder test double, same role as
// InMemoryCursorStore: lets the scheduler's unit tests assert on health
// recording without a running Postgres.
type InMemoryHealthRecorder struct {
	mu      sync.Mutex
	records map[string]healthRecord
}

type healthRecord struct {
	Success bool
	ErrMsg  string
}

func NewInMemoryHealthRecorder() *InMemoryHealthRecorder {
	return &InMemoryHealthRecorder{records: make(map[string]healthRecord)}
}

func (r *InMemoryHealthRecorder) RecordOutcome(_ context.Context, tenantID, connectorRowID string, success bool, errMsg string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.records[tenantID+"/"+connectorRowID] = healthRecord{Success: success, ErrMsg: errMsg}
	return nil
}

func (r *InMemoryHealthRecorder) Get(tenantID, connectorRowID string) (success bool, errMsg string, ok bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rec, ok := r.records[tenantID+"/"+connectorRowID]
	return rec.Success, rec.ErrMsg, ok
}
