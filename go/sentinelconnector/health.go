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
// data layer; P1-11 is what adds the HTTP endpoint that reads it back for a
// dashboard, now that P1-07 has landed and apps/api has a real server to put
// it on.
//
// status must be one of the connectors table's own check-constraint values
// this package ever writes: "healthy" (success), "degraded" (a transient
// failure — matches docs/architecture/overview.md's own framing, "Connector
// API down ... connector health degraded in UI"), or "revoked" (the
// connector's own Fetch/HealthCheck identified ErrConsentRevoked
// specifically, not just any error).
type HealthRecorder interface {
	RecordOutcome(ctx context.Context, tenantID, connectorRowID, status, errMsg string) error
}

// PostgresHealthRecorder writes through sentineldb.WithTenantContext, same
// as every other tenant-scoped write in this package.
type PostgresHealthRecorder struct {
	pool *pgxpool.Pool
}

func NewPostgresHealthRecorder(pool *pgxpool.Pool) *PostgresHealthRecorder {
	return &PostgresHealthRecorder{pool: pool}
}

func (r *PostgresHealthRecorder) RecordOutcome(ctx context.Context, tenantID, connectorRowID, status, errMsg string) error {
	var lastErr any
	if status != "healthy" {
		lastErr = errMsg
	}
	// last_sync_at only advances on an actual success — P1-11's whole lag
	// metric depends on this column meaning "the last time this connector
	// genuinely completed a cycle," not "the last time we checked," which
	// is what unconditionally bumping it to now() on every call (including
	// failures) would have meant. A connector failing every cycle for an
	// hour must show an hour of lag, not zero.
	query := `UPDATE connectors SET status = $1, last_error = $2 WHERE id = $3`
	args := []any{status, lastErr, connectorRowID}
	if status == "healthy" {
		query = `UPDATE connectors SET status = $1, last_error = $2, last_sync_at = now() WHERE id = $3`
	}
	_, err := sentineldb.WithTenantContext(ctx, r.pool, tenantID, func(ctx context.Context, tx pgx.Tx) (struct{}, error) {
		_, execErr := tx.Exec(ctx, query, args...)
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
	Status string
	ErrMsg string
}

func NewInMemoryHealthRecorder() *InMemoryHealthRecorder {
	return &InMemoryHealthRecorder{records: make(map[string]healthRecord)}
}

func (r *InMemoryHealthRecorder) RecordOutcome(_ context.Context, tenantID, connectorRowID, status, errMsg string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.records[tenantID+"/"+connectorRowID] = healthRecord{Status: status, ErrMsg: errMsg}
	return nil
}

func (r *InMemoryHealthRecorder) Get(tenantID, connectorRowID string) (status, errMsg string, ok bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rec, ok := r.records[tenantID+"/"+connectorRowID]
	return rec.Status, rec.ErrMsg, ok
}
