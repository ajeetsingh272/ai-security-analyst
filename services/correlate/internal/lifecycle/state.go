// Package lifecycle is the case lifecycle state machine (P3-03, TG6):
// which transitions are legal, and how a case's current state is
// derived from its append-only case_transitions log — never stored
// destructively (AC1), so a case's full history is always
// reconstructible from the log alone (AC4).
package lifecycle

// State is a case's lifecycle state — the same values
// case_transitions.to_state's own CHECK constraint accepts
// (db/postgres/migrations/0001_foundation.sql), named here instead of
// left as an untyped string so the legal-transition graph is only
// ever defined once, not re-validated ad hoc at every call site.
type State string

const (
	// StateNone is not a real case state — it means no transition has
	// ever been written for this case yet. The only legal transition
	// out of it is to StateOpen (a case's very first transition row).
	StateNone             State = ""
	StateOpen             State = "open"
	StateTriaging         State = "triaging"
	StateInvestigating    State = "investigating"
	StateAwaitingApproval State = "awaiting_approval"
	StateActioned         State = "actioned"
	StateClosed           State = "closed"
	StateDismissed        State = "dismissed"
)

// legalTransitions is docs/architecture/overview.md's own case
// lifecycle graph: open → triaging → investigating →
// awaiting_approval → actioned → closed, with dismissed reachable
// from triaging and investigating, and a failed response action
// returning actioned → awaiting_approval (overview.md's failure-mode
// table). It also includes two edges that section doesn't name:
//
//   - open → closed (predates this ticket, P3-02): a case that quiets
//     out before anything ever triages it, but whose score DID cross
//     the escalation threshold — services/correlate/internal/cluster's
//     own CloseQuietCases.
//   - open → dismissed (P3-07, TG3): the identical quiet-timeout path
//     for a case whose score never crossed the threshold — one that
//     should never have bothered anyone. AC1's own "every non-
//     escalated signal records a machine-readable dismissal reason"
//     is this edge, plus the reason CloseQuietCases now passes
//     alongside it (see cluster/postgres_store.go).
//   - dismissed → triaging (P3-07, AC5): "a dismissal can be
//     challenged, which reopens the case" — the only way out of what
//     was, before this ticket, a terminal state.
var legalTransitions = map[State]map[State]bool{
	StateNone:             {StateOpen: true},
	StateOpen:             {StateTriaging: true, StateClosed: true, StateDismissed: true},
	StateTriaging:         {StateInvestigating: true, StateDismissed: true},
	StateInvestigating:    {StateAwaitingApproval: true, StateDismissed: true},
	StateAwaitingApproval: {StateActioned: true},
	StateActioned:         {StateClosed: true, StateAwaitingApproval: true},
	StateClosed:           {},
	StateDismissed:        {StateTriaging: true},
}

// DismissalReason is a machine-readable code for WHY a case was
// dismissed (AC1) — a short, fixed, GROUP-BY-able string, never free
// prose, stored directly in case_transitions.reason for a dismissal
// transition specifically (ordinary transitions keep using a plain
// human-readable reason; only "to = StateDismissed" has this
// constraint, enforced in Writer.Transition).
type DismissalReason string

// ReasonBelowEscalationThreshold is the one dismissal reason this
// phase's own machinery can produce: a case quieted out
// (cluster.CloseQuietCases) without its score ever crossing
// scoring.EscalationThreshold. Later phases (an AI triage step
// actively dismissing a case, e.g.) will add their own reason codes
// here as they're built — this is not meant to be the final, complete
// set.
const ReasonBelowEscalationThreshold DismissalReason = "below_escalation_threshold"

// IsLegalTransition reports whether `to` is a permitted next state
// from `from`, per the case lifecycle graph above.
func IsLegalTransition(from, to State) bool {
	return legalTransitions[from][to]
}

// Transition is one case_transitions row, as CurrentState needs it.
type Transition struct {
	FromState State
	ToState   State
}

// CurrentState derives a case's current state from its transitions —
// the to_state of the most recently written row, nothing else.
// transitions must already be in the order they were actually written
// (ascending id); CurrentState does not sort them, matching
// case_transitions_case_idx's own (case_id, id) ordering.
func CurrentState(transitions []Transition) State {
	if len(transitions) == 0 {
		return StateNone
	}
	return transitions[len(transitions)-1].ToState
}
