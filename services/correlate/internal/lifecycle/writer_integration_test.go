//go:build integration

package lifecycle

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelaudit"
	"github.com/ajeetsingh272/ai-security-analyst/go/sentineldb"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func newTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := sentineldb.NewPool(context.Background())
	if err != nil {
		t.Fatalf("connecting to postgres: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func createTenant(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var tenantID string
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO tenants (name, plan) VALUES ($1, 'trial') RETURNING id`,
		"lifecycle probe "+time.Now().Format("20060102150405.000000000"),
	).Scan(&tenantID); err != nil {
		t.Fatalf("creating tenant fixture: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1`, tenantID)
	})
	return tenantID
}

// createCase inserts a fixture case row directly (not through the
// cluster package, which this test suite deliberately does not
// depend on, to keep lifecycle testable in isolation).
func createCase(t *testing.T, pool *pgxpool.Pool, tenantID string) string {
	t.Helper()
	var caseID string
	_, err := sentineldb.WithTenantContext(context.Background(), pool, tenantID, func(ctx context.Context, tx pgx.Tx) (struct{}, error) {
		return struct{}{}, tx.QueryRow(ctx,
			`INSERT INTO cases (tenant_id, window_start) VALUES ($1, now()) RETURNING id`,
			tenantID,
		).Scan(&caseID)
	})
	if err != nil {
		t.Fatalf("creating case fixture: %v", err)
	}
	return caseID
}

func countRows(t *testing.T, pool *pgxpool.Pool, tenantID, table, caseID string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		fmt.Sprintf(`SELECT count(*) FROM %s WHERE tenant_id = $1 AND case_id = $2`, table),
		tenantID, caseID,
	).Scan(&n); err != nil {
		t.Fatalf("counting %s rows: %v", table, err)
	}
	return n
}

// T3: a transition and its audit entry commit atomically or not at
// all. The first transition (open) commits normally; the second
// (triaging) is forced to fail after both its own writes have
// happened inside the same transaction — if either write were durable
// independently of the transaction, it would still be visible after
// rollback.
func TestWriter_TransitionCommitsAtomicallyWithAuditEntry(t *testing.T) {
	pool := newTestPool(t)
	tenantID := createTenant(t, pool)
	caseID := createCase(t, pool, tenantID)
	w := NewWriter(sentinelaudit.NewWriter(pool))
	ctx := context.Background()

	_, err := sentineldb.WithTenantContext(ctx, pool, tenantID, func(ctx context.Context, tx pgx.Tx) (struct{}, error) {
		return struct{}{}, w.Transition(ctx, tx, tenantID, caseID, StateOpen, sentinelaudit.ActorSystem, "lifecycle-test", "case created")
	})
	if err != nil {
		t.Fatalf("committing the open transition: %v", err)
	}
	if n := countRows(t, pool, tenantID, "case_transitions", caseID); n != 1 {
		t.Fatalf("got %d case_transitions rows after the committed open transition, want 1", n)
	}

	_, err = sentineldb.WithTenantContext(ctx, pool, tenantID, func(ctx context.Context, tx pgx.Tx) (struct{}, error) {
		if err := w.Transition(ctx, tx, tenantID, caseID, StateTriaging, sentinelaudit.ActorSystem, "lifecycle-test", "auto-triage"); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, fmt.Errorf("deliberate failure to force rollback")
	})
	if err == nil {
		t.Fatal("expected the deliberate failure to propagate")
	}

	if n := countRows(t, pool, tenantID, "case_transitions", caseID); n != 1 {
		t.Fatalf("got %d case_transitions rows after the rolled-back triaging transition, want 1 (only the committed open row)", n)
	}

	var auditCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM audit_log WHERE tenant_id = $1 AND subject_type = 'case' AND subject_id = $2`,
		tenantID, caseID,
	).Scan(&auditCount); err != nil {
		t.Fatalf("counting audit_log rows: %v", err)
	}
	if auditCount != 1 {
		t.Fatalf("got %d audit_log rows after the rolled-back transition, want 1 (only the committed open entry)", auditCount)
	}
}

func TestWriter_IllegalTransitionIsRejectedBeforeAnyWrite(t *testing.T) {
	pool := newTestPool(t)
	tenantID := createTenant(t, pool)
	caseID := createCase(t, pool, tenantID)
	w := NewWriter(sentinelaudit.NewWriter(pool))
	ctx := context.Background()

	// open -> actioned skips every intermediate stage; illegal.
	_, err := sentineldb.WithTenantContext(ctx, pool, tenantID, func(ctx context.Context, tx pgx.Tx) (struct{}, error) {
		return struct{}{}, w.Transition(ctx, tx, tenantID, caseID, StateActioned, sentinelaudit.ActorSystem, "lifecycle-test", "skip ahead")
	})
	if err == nil {
		t.Fatal("expected an illegal transition to be rejected")
	}

	if n := countRows(t, pool, tenantID, "case_transitions", caseID); n != 0 {
		t.Fatalf("got %d case_transitions rows after a rejected first transition, want 0", n)
	}
}

// T4: a case's full history is reconstructible after 100 transitions
// — padded out via the actioned<->awaiting_approval retry loop
// (overview.md's own documented "response action fails" edge), the
// only cycle the legal graph allows, before finally closing.
func TestWriter_FullHistoryReconstructibleAfter100Transitions(t *testing.T) {
	pool := newTestPool(t)
	tenantID := createTenant(t, pool)
	caseID := createCase(t, pool, tenantID)
	w := NewWriter(sentinelaudit.NewWriter(pool))
	ctx := context.Background()

	sequence := []State{StateOpen, StateTriaging, StateInvestigating, StateAwaitingApproval}
	for len(sequence) < 98 {
		sequence = append(sequence, StateActioned, StateAwaitingApproval)
	}
	sequence = append(sequence, StateActioned, StateClosed)

	from := StateNone
	for i, to := range sequence {
		if !IsLegalTransition(from, to) {
			t.Fatalf("test fixture itself is illegal at step %d: %q -> %q", i, from, to)
		}
		_, err := sentineldb.WithTenantContext(ctx, pool, tenantID, func(ctx context.Context, tx pgx.Tx) (struct{}, error) {
			return struct{}{}, w.Transition(ctx, tx, tenantID, caseID, to, sentinelaudit.ActorSystem, "lifecycle-test", fmt.Sprintf("step %d", i))
		})
		if err != nil {
			t.Fatalf("step %d (%q -> %q): %v", i, from, to, err)
		}
		from = to
	}
	if len(sequence) != 100 {
		t.Fatalf("test fixture has %d transitions, want exactly 100", len(sequence))
	}

	rows, err := pool.Query(ctx,
		`SELECT from_state, to_state FROM case_transitions WHERE tenant_id = $1 AND case_id = $2 ORDER BY id`,
		tenantID, caseID,
	)
	if err != nil {
		t.Fatalf("reading back history: %v", err)
	}
	defer rows.Close()

	var reconstructed []Transition
	for rows.Next() {
		var fromState *string
		var toState string
		if err := rows.Scan(&fromState, &toState); err != nil {
			t.Fatalf("scanning history row: %v", err)
		}
		tr := Transition{ToState: State(toState)}
		if fromState != nil {
			tr.FromState = State(*fromState)
		}
		reconstructed = append(reconstructed, tr)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterating history: %v", err)
	}

	if len(reconstructed) != 100 {
		t.Fatalf("reconstructed %d transitions, want 100", len(reconstructed))
	}
	for i, tr := range reconstructed {
		if tr.ToState != sequence[i] {
			t.Errorf("transition %d: got to_state %q, want %q", i, tr.ToState, sequence[i])
		}
	}
	if got := CurrentState(reconstructed); got != StateClosed {
		t.Errorf("CurrentState after reconstruction = %q, want StateClosed", got)
	}

	var auditCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM audit_log WHERE tenant_id = $1 AND subject_type = 'case' AND subject_id = $2 AND action = 'case.transition'`,
		tenantID, caseID,
	).Scan(&auditCount); err != nil {
		t.Fatalf("counting audit_log rows: %v", err)
	}
	if auditCount != 100 {
		t.Fatalf("got %d audit_log entries for this case, want 100 (one per transition)", auditCount)
	}
}
