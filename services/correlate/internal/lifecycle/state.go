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
// table). It also includes one edge that section doesn't name because
// it predates this ticket: open → closed, for a case that quiets out
// before anything ever triages it —
// services/correlate/internal/cluster's own CloseQuietCases (shipped
// in P3-02) already writes exactly this edge, with the reason "quiet
// period elapsed with no new signal".
var legalTransitions = map[State]map[State]bool{
	StateNone:             {StateOpen: true},
	StateOpen:             {StateTriaging: true, StateClosed: true},
	StateTriaging:         {StateInvestigating: true, StateDismissed: true},
	StateInvestigating:    {StateAwaitingApproval: true, StateDismissed: true},
	StateAwaitingApproval: {StateActioned: true},
	StateActioned:         {StateClosed: true, StateAwaitingApproval: true},
	StateClosed:           {},
	StateDismissed:        {},
}

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
