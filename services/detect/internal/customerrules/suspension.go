package customerrules

import (
	"context"
	"log/slog"
	"sync"
)

// maxConsecutiveTimeouts is ADR-0012 §2's own number: five consecutive
// over-budget evaluations auto-suspends a rule. Five, not one, because
// a single slow evaluation can legitimately be GC pressure or a
// scheduler hiccup on the host, not the rule's own fault — consecutive
// is what distinguishes "this rule is the problem" from noise.
const maxConsecutiveTimeouts = 5

// SuspensionStore is the one write this tracker needs — narrowed to
// an interface at the consumer, the same pattern every other store
// dependency in this package already follows, so the tracker's own
// threshold logic has a unit test that needs no real Postgres.
type SuspensionStore interface {
	Suspend(ctx context.Context, tenantID, ruleID string) error
}

// SuspensionTracker is ADR-0012 §2's own defense-in-depth mechanism:
// it cannot stop a single evaluation already in progress (Go has no
// safe goroutine-preemption primitive), but it does stop a
// CONSISTENTLY slow rule from ever being evaluated again, bounding
// the damage window a validator bug could otherwise leave open
// indefinitely. Keyed by tenantID+ruleID so one tenant's rule timing
// out has no effect on any other tenant's own count — the identical
// tenant-isolation argument ADR-0012 §4 makes elsewhere, applied to
// this bookkeeping too.
type SuspensionTracker struct {
	store SuspensionStore
	log   *slog.Logger
	mu    sync.Mutex
	count map[string]int // key: tenantID+"\x00"+ruleID
}

func NewSuspensionTracker(store SuspensionStore, log *slog.Logger) *SuspensionTracker {
	if log == nil {
		log = slog.Default()
	}
	return &SuspensionTracker{store: store, log: log, count: map[string]int{}}
}

func key(tenantID, ruleID string) string { return tenantID + "\x00" + ruleID }

// Record is called once per rule per evaluated event. timedOut is
// whether THIS evaluation exceeded the budget — a non-timing-out
// evaluation resets the tenant+rule's own streak to zero, since the
// threshold is about CONSECUTIVE violations, not a lifetime total.
func (t *SuspensionTracker) Record(ctx context.Context, tenantID, ruleID string, timedOut bool) {
	t.mu.Lock()
	k := key(tenantID, ruleID)
	if !timedOut {
		delete(t.count, k)
		t.mu.Unlock()
		return
	}
	t.count[k]++
	n := t.count[k]
	suspend := n >= maxConsecutiveTimeouts
	if suspend {
		delete(t.count, k) // the rule is about to stop being evaluated at all; nothing left to count
	}
	t.mu.Unlock()

	if suspend {
		if err := t.store.Suspend(ctx, tenantID, ruleID); err != nil {
			t.log.Error("customerrules: suspending a repeatedly over-budget rule failed", "tenant_id", tenantID, "rule_id", ruleID, "err", err)
			return
		}
		t.log.Error("customerrules: rule auto-suspended after repeated resource-budget violations", "tenant_id", tenantID, "rule_id", ruleID, "consecutive_timeouts", n)
	}
}
