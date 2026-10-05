package sentinelconnector

import (
	"context"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/ocsf"
)

// T3/T4 are labelled "integration" in the ticket, but what they actually
// prove — one goroutine's stall not blocking another's schedule, and
// Shutdown draining an in-flight cycle rather than aborting it — is a
// property of the Scheduler's own concurrency design, not of Postgres or
// any live service. PostgresCursorStore's Get/Commit are thin wrappers
// already proven correct against the real database by sentineldb's own
// integration test; re-proving that here would only add I/O latency and
// flakiness to a timing-sensitive test without adding confidence. These use
// the in-memory fakes deliberately, same as T1/T2, and deterministic
// channels rather than sleeps for every assertion that matters.

// blockingConnector blocks inside Fetch until unblock is closed, then
// returns a successful batch — lets a test control exactly when a "slow"
// cycle is allowed to complete, instead of racing against a sleep.
type blockingConnector struct {
	id         ConnectorID
	unblock    chan struct{}
	fetchCalls atomic.Int32
	nextCursor Cursor
	batch      Batch
}

func (c *blockingConnector) ID() ConnectorID { return c.id }

func (c *blockingConnector) Fetch(ctx context.Context, _ Cursor) (Batch, Cursor, error) {
	c.fetchCalls.Add(1)
	select {
	case <-c.unblock:
	case <-ctx.Done():
		return Batch{}, nil, ctx.Err()
	}
	return c.batch, c.nextCursor, nil
}

func (c *blockingConnector) Normalise(raw RawEvent) ([]ocsf.Event, error) {
	return []ocsf.Event{{TenantID: raw.TenantID, RawData: raw.Payload}}, nil
}

func (c *blockingConnector) HealthCheck(context.Context) error { return nil }

// fastConnector completes every cycle immediately — the "healthy other
// tenant" in T3.
type fastConnector struct {
	id    ConnectorID
	calls atomic.Int32
}

func (c *fastConnector) ID() ConnectorID { return c.id }

func (c *fastConnector) Fetch(context.Context, Cursor) (Batch, Cursor, error) {
	n := c.calls.Add(1)
	return Batch{}, Cursor([]byte(`{"n":` + strconv.Itoa(int(n)) + `}`)), nil
}

func (c *fastConnector) Normalise(RawEvent) ([]ocsf.Event, error) { return nil, nil }

func (c *fastConnector) HealthCheck(context.Context) error { return nil }

const tenantA = "11111111-1111-4111-8111-111111111111"
const tenantB = "22222222-2222-4222-8222-222222222222"

// T3: one tenant's failing (here: permanently stalled) connector does not
// delay another tenant's schedule.
func TestStalledTenantDoesNotDelayAnotherTenant(t *testing.T) {
	stalled := &blockingConnector{id: "stalled", unblock: make(chan struct{})}
	defer close(stalled.unblock) // let its goroutine exit cleanly when the test ends

	fast := &fastConnector{id: "fast"}

	s := NewScheduler(NewInMemoryPublisher(), NewInMemoryCursorStore(), SchedulerOptions{Interval: 5 * time.Millisecond})
	s.Register(TenantConnector{TenantID: tenantA, ConnectorRowID: "conn-a", Stream: "main", Connector: stalled})
	s.Register(TenantConnector{TenantID: tenantB, ConnectorRowID: "conn-b", Stream: "main", Connector: fast})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.Start(ctx)

	// Poll for "fast" to have completed several cycles, bounded by an
	// overall deadline rather than a fixed sleep — fast under normal load,
	// still correct if CI happens to be slow.
	deadline := time.After(2 * time.Second)
	for {
		if fast.calls.Load() >= 5 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("tenant B only completed %d cycles in 2s — appears blocked by tenant A's stalled connector", fast.calls.Load())
		case <-time.After(10 * time.Millisecond):
		}
	}

	// The stalled connector should still be on its FIRST call, still
	// blocked — proving it never got a chance to delay anything, and
	// proving tenant B's progress didn't depend on it finishing.
	if calls := stalled.fetchCalls.Load(); calls != 1 {
		t.Fatalf("expected the stalled connector's Fetch to have been called exactly once (still in flight), got %d calls", calls)
	}

	// cancel() only stops the loops from starting a NEW cycle (see Start's
	// doc comment) — it does not reach into the stalled cycle, which is
	// deliberately still running on context.Background(). The deferred
	// close(stalled.unblock) above is what actually lets that goroutine
	// exit; Shutdown's drain behaviour itself is T4's test, not this one's.
	cancel()
}

// T4: SIGTERM (simulated here as Shutdown) during a batch drains cleanly —
// the in-flight cycle is allowed to finish and commit, and no NEW cycle
// starts once shutdown has been requested.
func TestShutdownDrainsInFlightCycleWithoutStartingANewOne(t *testing.T) {
	conn := &blockingConnector{
		id:         "slow",
		unblock:    make(chan struct{}),
		batch:      Batch{Events: []RawEvent{{TenantID: tenantA, Payload: []byte(`{"x":1}`)}}},
		nextCursor: Cursor(`{"page":2}`),
	}

	cursors := NewInMemoryCursorStore()
	s := NewScheduler(NewInMemoryPublisher(), cursors, SchedulerOptions{Interval: 5 * time.Millisecond})
	s.Register(TenantConnector{TenantID: tenantA, ConnectorRowID: "conn-a", Stream: "main", Connector: conn})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.Start(ctx)

	// Wait for the cycle to actually start (Fetch called, now blocked
	// inside it) before requesting shutdown — this is what makes the test
	// prove "drains an IN-FLIGHT batch" rather than just "stops cleanly
	// between batches", which would be a much weaker claim.
	deadline := time.After(2 * time.Second)
	for conn.fetchCalls.Load() == 0 {
		select {
		case <-deadline:
			t.Fatal("connector's Fetch was never called within 2s")
		case <-time.After(5 * time.Millisecond):
		}
	}

	shutdownDone := make(chan error, 1)
	go func() {
		shutdownDone <- s.Shutdown(context.Background())
	}()

	// Shutdown must still be blocked, waiting on the in-flight cycle —
	// asserting this is what proves "drain", not "abort": if Shutdown
	// returned before the cycle finished, it would mean the cycle was cut
	// off rather than allowed to complete.
	select {
	case <-shutdownDone:
		t.Fatal("Shutdown returned before the in-flight cycle finished — it aborted instead of draining")
	case <-time.After(100 * time.Millisecond):
	}

	// Now let the in-flight cycle complete.
	close(conn.unblock)

	select {
	case err := <-shutdownDone:
		if err != nil {
			t.Fatalf("Shutdown returned an error after the cycle completed: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Shutdown did not return within 2s after the in-flight cycle was unblocked")
	}

	// The drained cycle must have committed — "drains cleanly" means
	// completed and committed, not silently discarded.
	cur, ok, err := cursors.Get(context.Background(), tenantA, "conn-a", "main")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !ok || string(cur) != `{"page":2}` {
		t.Fatalf("expected the in-flight cycle's cursor to be committed as {\"page\":2}, got ok=%v cur=%s", ok, cur)
	}

	// And no second cycle may have started after shutdown was requested,
	// even though the 5ms interval would have fired many more times by now
	// if the loop hadn't stopped accepting new ticks.
	if calls := conn.fetchCalls.Load(); calls != 1 {
		t.Fatalf("expected exactly 1 Fetch call (no new cycle after shutdown was requested), got %d", calls)
	}
}
