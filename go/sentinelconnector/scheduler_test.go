package sentinelconnector

import (
	"context"
	"errors"
	"testing"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/ocsf"
)

// fakeConnector lets tests control exactly what Fetch/Normalise return,
// without a real vendor API or OCSF mapping — P1-01's scheduler tests are
// about the ORCHESTRATION logic (fetch → normalise → publish → commit
// ordering), not about any particular connector's behaviour.
type fakeConnector struct {
	id ConnectorID

	fetchBatch      Batch
	fetchNextCursor Cursor
	fetchErr        error
	fetchCalls      int

	normaliseErr error
}

func (f *fakeConnector) ID() ConnectorID { return f.id }

func (f *fakeConnector) Fetch(_ context.Context, _ Cursor) (Batch, Cursor, error) {
	f.fetchCalls++
	if f.fetchErr != nil {
		return Batch{}, nil, f.fetchErr
	}
	return f.fetchBatch, f.fetchNextCursor, nil
}

func (f *fakeConnector) Normalise(raw RawEvent) ([]ocsf.Event, error) {
	if f.normaliseErr != nil {
		return nil, f.normaliseErr
	}
	return []ocsf.Event{{TenantID: raw.TenantID, RawData: raw.Payload}}, nil
}

func (f *fakeConnector) HealthCheck(_ context.Context) error { return nil }

const probeTenant = "11111111-1111-4111-8111-111111111111"

func TestCursorAdvancesOnlyAfterPublishSucceeds(t *testing.T) {
	pub := NewInMemoryPublisher()
	cursors := NewInMemoryCursorStore()
	conn := &fakeConnector{
		id:              "fake",
		fetchBatch:      Batch{Events: []RawEvent{{TenantID: probeTenant, Payload: []byte(`{"x":1}`)}}},
		fetchNextCursor: Cursor(`{"page":2}`),
	}
	s := NewScheduler(pub, cursors, SchedulerOptions{})
	tc := TenantConnector{TenantID: probeTenant, ConnectorRowID: "conn-1", Stream: "main", Connector: conn}

	outcome := s.runCycle(context.Background(), tc)
	if outcome != "success" {
		t.Fatalf("expected outcome=success, got %q", outcome)
	}

	cur, ok, err := cursors.Get(context.Background(), probeTenant, "conn-1", "main")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !ok {
		t.Fatal("expected the cursor to be committed after a successful publish")
	}
	if string(cur) != `{"page":2}` {
		t.Fatalf("expected committed cursor {\"page\":2}, got %s", cur)
	}

	if published := pub.Published(probeTenant); len(published) != 1 {
		t.Fatalf("expected 1 event published, got %d", len(published))
	}
}

// T2: a connector returning an error does not advance its cursor.
func TestFetchErrorDoesNotAdvanceCursor(t *testing.T) {
	pub := NewInMemoryPublisher()
	cursors := NewInMemoryCursorStore()
	conn := &fakeConnector{id: "fake", fetchErr: errors.New("vendor API unreachable")}
	s := NewScheduler(pub, cursors, SchedulerOptions{})
	tc := TenantConnector{TenantID: probeTenant, ConnectorRowID: "conn-1", Stream: "main", Connector: conn}

	outcome := s.runCycle(context.Background(), tc)
	if outcome != "fetch_error" {
		t.Fatalf("expected outcome=fetch_error, got %q", outcome)
	}

	_, ok, err := cursors.Get(context.Background(), probeTenant, "conn-1", "main")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if ok {
		t.Fatal("cursor must not be committed when Fetch errors")
	}
	if len(pub.Published(probeTenant)) != 0 {
		t.Fatal("nothing should have been published when Fetch errors")
	}
}

// T1's other half: even when Fetch succeeds, a publish failure must ALSO
// block the cursor — "only after a successful Kafka acknowledgement" means
// both halves of the ordering, not just the connector-error case T2 names.
func TestPublishFailureDoesNotAdvanceCursor(t *testing.T) {
	pub := NewInMemoryPublisher()
	pub.FailNext()
	cursors := NewInMemoryCursorStore()
	conn := &fakeConnector{
		id:              "fake",
		fetchBatch:      Batch{Events: []RawEvent{{TenantID: probeTenant, Payload: []byte(`{"x":1}`)}}},
		fetchNextCursor: Cursor(`{"page":2}`),
	}
	s := NewScheduler(pub, cursors, SchedulerOptions{})
	tc := TenantConnector{TenantID: probeTenant, ConnectorRowID: "conn-1", Stream: "main", Connector: conn}

	outcome := s.runCycle(context.Background(), tc)
	if outcome != "publish_error" {
		t.Fatalf("expected outcome=publish_error, got %q", outcome)
	}

	_, ok, err := cursors.Get(context.Background(), probeTenant, "conn-1", "main")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if ok {
		t.Fatal("cursor must not be committed when publish fails — this is ADR-0010's entire guarantee")
	}
}

func TestNormaliseErrorDoesNotAdvanceCursor(t *testing.T) {
	pub := NewInMemoryPublisher()
	cursors := NewInMemoryCursorStore()
	conn := &fakeConnector{
		id:           "fake",
		fetchBatch:   Batch{Events: []RawEvent{{TenantID: probeTenant, Payload: []byte(`bad`)}}},
		normaliseErr: errors.New("unrecognised event shape"),
	}
	s := NewScheduler(pub, cursors, SchedulerOptions{})
	tc := TenantConnector{TenantID: probeTenant, ConnectorRowID: "conn-1", Stream: "main", Connector: conn}

	outcome := s.runCycle(context.Background(), tc)
	if outcome != "normalise_error" {
		t.Fatalf("expected outcome=normalise_error, got %q", outcome)
	}
	if _, ok, _ := cursors.Get(context.Background(), probeTenant, "conn-1", "main"); ok {
		t.Fatal("cursor must not be committed when Normalise errors")
	}
}

func TestHealthRecorderReflectsCycleOutcome(t *testing.T) {
	cursors := NewInMemoryCursorStore()
	health := NewInMemoryHealthRecorder()

	s := NewScheduler(NewInMemoryPublisher(), cursors, SchedulerOptions{Health: health})

	okConn := &fakeConnector{id: "fake", fetchBatch: Batch{}, fetchNextCursor: Cursor(`{}`)}
	okTC := TenantConnector{TenantID: probeTenant, ConnectorRowID: "conn-ok", Stream: "main", Connector: okConn}
	// runOnce, not runCycle directly — recordCycle (which calls the health
	// recorder) is runOnce's job, not runCycle's own.
	s.runOnce(context.Background(), okTC)

	success, errMsg, ok := health.Get(probeTenant, "conn-ok")
	if !ok {
		t.Fatal("expected a health record for the successful cycle")
	}
	if !success || errMsg != "" {
		t.Fatalf("expected success=true errMsg=\"\", got success=%v errMsg=%q", success, errMsg)
	}

	failConn := &fakeConnector{id: "fake", fetchErr: errors.New("vendor down")}
	failTC := TenantConnector{TenantID: probeTenant, ConnectorRowID: "conn-fail", Stream: "main", Connector: failConn}
	s.runOnce(context.Background(), failTC)

	success, errMsg, ok = health.Get(probeTenant, "conn-fail")
	if !ok {
		t.Fatal("expected a health record for the failed cycle")
	}
	if success || errMsg == "" {
		t.Fatalf("expected success=false with a non-empty errMsg, got success=%v errMsg=%q", success, errMsg)
	}
}

func TestEmptyBatchStillAdvancesCursor(t *testing.T) {
	// An empty batch has nothing to lose by advancing — e.g. a vendor API
	// page with zero new events still has a valid "nothing here yet" cursor
	// worth remembering, so the next cycle doesn't re-scan the same empty
	// window forever.
	pub := NewInMemoryPublisher()
	cursors := NewInMemoryCursorStore()
	conn := &fakeConnector{id: "fake", fetchBatch: Batch{}, fetchNextCursor: Cursor(`{"page":1}`)}
	s := NewScheduler(pub, cursors, SchedulerOptions{})
	tc := TenantConnector{TenantID: probeTenant, ConnectorRowID: "conn-1", Stream: "main", Connector: conn}

	outcome := s.runCycle(context.Background(), tc)
	if outcome != "success" {
		t.Fatalf("expected outcome=success for an empty batch, got %q", outcome)
	}
	cur, ok, _ := cursors.Get(context.Background(), probeTenant, "conn-1", "main")
	if !ok || string(cur) != `{"page":1}` {
		t.Fatalf("expected cursor to advance to {\"page\":1} even for an empty batch, got ok=%v cur=%s", ok, cur)
	}
}
