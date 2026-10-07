package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelaudit"
	"github.com/jackc/pgx/v5"
)

// ErrDismissalReasonRequired is returned by Transition when `to` is
// StateDismissed and reason is empty or blank — P3-07's own AC1/T2:
// "a dismissal without a reason is rejected at write time." Checked
// before anything is written, the same as an illegal transition.
var ErrDismissalReasonRequired = errors.New("lifecycle: a dismissal requires a non-empty, machine-readable reason")

// Writer appends one case_transitions row and its audit_log entry in
// the SAME caller-provided transaction (AC5) — an illegal transition
// is rejected with a clear error before either write happens (AC2),
// and neither row is written if the other fails, since both share the
// caller's own transaction rather than opening one of their own.
type Writer struct {
	audit *sentinelaudit.Writer
}

func NewWriter(audit *sentinelaudit.Writer) *Writer {
	return &Writer{audit: audit}
}

// Transition appends a transition to `to` for case caseID. tx must
// already be running as sentinel_app with app.tenant_id set to
// tenantID (i.e. obtained via sentineldb.WithTenantContext) — the same
// requirement sentinelaudit.Writer.WriteTx itself has, and for the
// identical reason: establishing tenant context is the caller's job,
// since it may need to share this transaction with its own other
// writes (e.g. case_signals).
func (w *Writer) Transition(ctx context.Context, tx pgx.Tx, tenantID, caseID string, to State, actorType sentinelaudit.ActorType, actorID, reason string) error {
	// Checked before any I/O at all — T2's own "a dismissal without a
	// reason is rejected at write time" is provable with no tx and no
	// database, just this function and its arguments.
	if to == StateDismissed && strings.TrimSpace(reason) == "" {
		return ErrDismissalReasonRequired
	}

	current, err := currentState(ctx, tx, tenantID, caseID)
	if err != nil {
		return fmt.Errorf("lifecycle: reading current state for case %s: %w", caseID, err)
	}
	if !IsLegalTransition(current, to) {
		return fmt.Errorf("lifecycle: illegal transition for case %s: %q -> %q is not permitted", caseID, current, to)
	}

	var fromState *string
	if current != StateNone {
		s := string(current)
		fromState = &s
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO case_transitions (tenant_id, case_id, from_state, to_state, actor_type, actor_id, reason)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		tenantID, caseID, fromState, string(to), string(actorType), actorID, reason,
	); err != nil {
		return fmt.Errorf("lifecycle: inserting transition for case %s: %w", caseID, err)
	}

	if _, err := w.audit.WriteTx(ctx, tx, tenantID, sentinelaudit.EntryInput{
		ActorType: actorType, ActorID: actorID,
		Action: "case.transition", SubjectType: "case", SubjectID: caseID,
		Payload: map[string]any{"fromState": string(current), "toState": string(to), "reason": reason},
	}); err != nil {
		return fmt.Errorf("lifecycle: writing audit entry for case %s: %w", caseID, err)
	}
	return nil
}

func currentState(ctx context.Context, tx pgx.Tx, tenantID, caseID string) (State, error) {
	var s string
	err := tx.QueryRow(ctx,
		`SELECT to_state FROM case_transitions WHERE tenant_id = $1 AND case_id = $2 ORDER BY id DESC LIMIT 1`,
		tenantID, caseID,
	).Scan(&s)
	if errors.Is(err, pgx.ErrNoRows) {
		return StateNone, nil
	}
	if err != nil {
		return "", err
	}
	return State(s), nil
}
