package lifecycle

import (
	"context"
	"errors"
	"testing"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelaudit"
)

// T2: a dismissal without a reason is rejected at write time — pure,
// no database at all: Transition checks this before ever touching tx,
// so a nil pgx.Tx (never dereferenced on this path) is enough to prove
// it.
func TestTransition_DismissalWithoutReasonIsRejected(t *testing.T) {
	w := NewWriter(sentinelaudit.NewWriter(nil))

	err := w.Transition(context.Background(), nil, "tenant-1", "case-1", StateDismissed, sentinelaudit.ActorSystem, "correlate", "")
	if !errors.Is(err, ErrDismissalReasonRequired) {
		t.Errorf("got %v, want ErrDismissalReasonRequired", err)
	}
}

func TestTransition_DismissalWithWhitespaceOnlyReasonIsRejected(t *testing.T) {
	w := NewWriter(sentinelaudit.NewWriter(nil))

	err := w.Transition(context.Background(), nil, "tenant-1", "case-1", StateDismissed, sentinelaudit.ActorSystem, "correlate", "   ")
	if !errors.Is(err, ErrDismissalReasonRequired) {
		t.Errorf("got %v, want ErrDismissalReasonRequired", err)
	}
}
