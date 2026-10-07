package lifecycle

import "testing"

// T1: every legal transition in docs/architecture/overview.md's own
// case lifecycle graph is permitted, and every other pair — including
// every attempt to leave a terminal state, skip a stage, or re-enter
// an already-left one — is rejected. The expected set is written out
// independently here, from the spec, rather than derived from
// legalTransitions itself, so this test can actually catch a mistake
// in that map rather than just restating it.
func TestIsLegalTransition_MatchesTheDocumentedGraph(t *testing.T) {
	legal := map[[2]State]bool{
		{StateNone, StateOpen}:                      true,
		{StateOpen, StateTriaging}:                  true,
		{StateOpen, StateClosed}:                    true,
		{StateOpen, StateDismissed}:                 true,
		{StateTriaging, StateInvestigating}:         true,
		{StateTriaging, StateDismissed}:             true,
		{StateInvestigating, StateAwaitingApproval}: true,
		{StateInvestigating, StateDismissed}:        true,
		{StateAwaitingApproval, StateActioned}:      true,
		{StateActioned, StateClosed}:                true,
		{StateActioned, StateAwaitingApproval}:      true,
		{StateDismissed, StateTriaging}:             true,
	}

	all := []State{
		StateNone, StateOpen, StateTriaging, StateInvestigating,
		StateAwaitingApproval, StateActioned, StateClosed, StateDismissed,
	}

	for _, from := range all {
		for _, to := range all {
			want := legal[[2]State{from, to}]
			got := IsLegalTransition(from, to)
			if got != want {
				t.Errorf("IsLegalTransition(%q, %q) = %v, want %v", from, to, got, want)
			}
		}
	}
}

func TestIsLegalTransition_ClosedIsTerminal(t *testing.T) {
	all := []State{
		StateNone, StateOpen, StateTriaging, StateInvestigating,
		StateAwaitingApproval, StateActioned, StateClosed, StateDismissed,
	}
	for _, to := range all {
		if IsLegalTransition(StateClosed, to) {
			t.Errorf("IsLegalTransition(%q, %q) = true, want false — %q is terminal", StateClosed, to, StateClosed)
		}
	}
}

// P3-07/AC5: "a dismissal can be challenged" — dismissed is no longer
// terminal, but its ONLY legal exit is back into triaging (a
// challenge), never anywhere else.
func TestIsLegalTransition_DismissedOnlyExitsToTriaging(t *testing.T) {
	all := []State{
		StateNone, StateOpen, StateTriaging, StateInvestigating,
		StateAwaitingApproval, StateActioned, StateClosed, StateDismissed,
	}
	for _, to := range all {
		want := to == StateTriaging
		if got := IsLegalTransition(StateDismissed, to); got != want {
			t.Errorf("IsLegalTransition(%q, %q) = %v, want %v", StateDismissed, to, got, want)
		}
	}
}

// T2: a case's current state is always just the to_state of the most
// recently written transition — correct for an arbitrary legal
// sequence, including one that loops through the
// actioned<->awaiting_approval retry edge before finally closing.
func TestCurrentState_DerivesFromArbitraryLegalSequence(t *testing.T) {
	sequence := []State{
		StateOpen, StateTriaging, StateInvestigating, StateAwaitingApproval,
		StateActioned, StateAwaitingApproval, StateActioned, StateClosed,
	}

	var transitions []Transition
	from := StateNone
	for _, to := range sequence {
		if !IsLegalTransition(from, to) {
			t.Fatalf("test fixture itself is illegal: %q -> %q", from, to)
		}
		transitions = append(transitions, Transition{FromState: from, ToState: to})
		from = to

		if got := CurrentState(transitions); got != to {
			t.Errorf("after appending %q, CurrentState = %q, want %q", to, got, to)
		}
	}
}

func TestCurrentState_EmptyHistoryIsStateNone(t *testing.T) {
	if got := CurrentState(nil); got != StateNone {
		t.Errorf("CurrentState(nil) = %q, want StateNone", got)
	}
}

func TestCurrentState_DismissedSequenceFromTriaging(t *testing.T) {
	transitions := []Transition{
		{FromState: StateNone, ToState: StateOpen},
		{FromState: StateOpen, ToState: StateTriaging},
		{FromState: StateTriaging, ToState: StateDismissed},
	}
	if got := CurrentState(transitions); got != StateDismissed {
		t.Errorf("CurrentState = %q, want StateDismissed", got)
	}
}
