package sentinelconnector

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// fakeRawArchiveWriter is a test double for RawArchiveWriter: records every
// call it receives (so a test can assert exactly what was archived, and in
// what order relative to Normalise/Publish) and can be armed to fail.
type fakeRawArchiveWriter struct {
	mu       sync.Mutex
	calls    []rawArchiveCall
	failNext bool
}

type rawArchiveCall struct {
	TenantID       string
	ConnectorRowID string
	Events         []RawEvent
}

func (f *fakeRawArchiveWriter) ArchiveRaw(_ context.Context, tenantID, connectorRowID string, _ time.Time, events []RawEvent) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failNext {
		f.failNext = false
		return errors.New("fakeRawArchiveWriter: ArchiveRaw failed (armed)")
	}
	f.calls = append(f.calls, rawArchiveCall{TenantID: tenantID, ConnectorRowID: connectorRowID, Events: events})
	return nil
}

func (f *fakeRawArchiveWriter) Calls() []rawArchiveCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]rawArchiveCall(nil), f.calls...)
}

// T1 (unit half — the integration half against real S3 lives in
// raw_archive_integration_test.go): every fetched event reaches
// RawArchiveWriter.ArchiveRaw exactly once, before Normalise runs at all.
func TestRawArchiveReceivesEveryFetchedEventBeforeNormalise(t *testing.T) {
	pub := NewInMemoryPublisher()
	cursors := NewInMemoryCursorStore()
	rawArchive := &fakeRawArchiveWriter{}

	conn := &fakeConnector{
		id: "fake",
		fetchBatch: Batch{Events: []RawEvent{
			{TenantID: probeTenant, Payload: []byte(`{"n":1}`)},
			{TenantID: probeTenant, Payload: []byte(`{"n":2}`)},
		}},
		fetchNextCursor: Cursor(`{"page":2}`),
	}
	s := NewScheduler(pub, cursors, SchedulerOptions{RawArchive: rawArchive})
	tc := TenantConnector{TenantID: probeTenant, ConnectorRowID: "conn-1", Stream: "main", Connector: conn}

	outcome, _ := s.runCycle(context.Background(), tc)
	if outcome != "success" {
		t.Fatalf("expected outcome=success, got %q", outcome)
	}

	calls := rawArchive.Calls()
	if len(calls) != 1 {
		t.Fatalf("expected exactly 1 ArchiveRaw call for 1 fetch, got %d", len(calls))
	}
	if len(calls[0].Events) != 2 {
		t.Fatalf("expected both fetched events archived, got %d", len(calls[0].Events))
	}
	if calls[0].TenantID != probeTenant || calls[0].ConnectorRowID != "conn-1" {
		t.Fatalf("archived under wrong tenant/connector: %+v", calls[0])
	}
}

// T2: archive write failure fails the batch rather than silently
// proceeding — the cycle must stop before Normalise/Publish, and the
// cursor must not advance, so the next cycle retries the identical fetch
// and gets another chance to archive it.
func TestRawArchiveFailureFailsTheWholeCycle(t *testing.T) {
	pub := NewInMemoryPublisher()
	cursors := NewInMemoryCursorStore()
	rawArchive := &fakeRawArchiveWriter{failNext: true}

	conn := &fakeConnector{
		id:              "fake",
		fetchBatch:      Batch{Events: []RawEvent{{TenantID: probeTenant, Payload: []byte(`{"n":1}`)}}},
		fetchNextCursor: Cursor(`{"page":2}`),
	}
	s := NewScheduler(pub, cursors, SchedulerOptions{RawArchive: rawArchive})
	tc := TenantConnector{TenantID: probeTenant, ConnectorRowID: "conn-1", Stream: "main", Connector: conn}

	outcome, _ := s.runCycle(context.Background(), tc)
	if outcome != "raw_archive_error" {
		t.Fatalf("expected outcome=raw_archive_error, got %q", outcome)
	}

	if _, ok, _ := cursors.Get(context.Background(), probeTenant, "conn-1", "main"); ok {
		t.Fatal("expected the cursor to NOT have been committed after a raw-archive failure")
	}
	if published := pub.Published(probeTenant); len(published) != 0 {
		t.Fatalf("expected nothing published when raw archiving fails first, got %d", len(published))
	}
}
