package syslog

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector"
)

const testTenantID = "55555555-5555-4555-8555-555555555555"

func newTestListener(t *testing.T) *Listener {
	t.Helper()
	l, err := NewListener("127.0.0.1:0", nil)
	if err != nil {
		t.Fatalf("NewListener: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancel()
		_ = l.Close()
	})
	go l.Serve(ctx)
	return l
}

func sendLines(t *testing.T, addr string, lines ...string) {
	t.Helper()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	for _, line := range lines {
		if _, err := conn.Write([]byte(line + "\n")); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
}

// T1: "Syslog connector ingests RFC 5424 messages end to end" — a real
// TCP connection, a real listener, through Fetch and Normalise.
func TestSyslogConnector_IngestsRFC5424EndToEnd(t *testing.T) {
	listener := newTestListener(t)
	sendLines(t, listener.Addr(),
		`<34>1 2024-01-01T00:00:00Z host1 sshd 1234 - [meta@1 x="1"] login failed`,
		`<14>1 2024-01-01T00:00:01Z host2 app - - - hello world`,
	)

	// The listener's read loop runs in its own goroutine; give it a
	// moment to actually process both lines before Fetching.
	deadline := time.Now().Add(2 * time.Second)
	conn := NewConnector(testTenantID, listener)
	for listener.buf.len() < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}

	batch, _, err := conn.Fetch(context.Background(), nil)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if len(batch.Events) != 2 {
		t.Fatalf("expected 2 raw events, got %d", len(batch.Events))
	}

	events, err := conn.Normalise(batch.Events[0])
	if err != nil {
		t.Fatalf("Normalise: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 ocsf event, got %d", len(events))
	}
	ev := events[0]
	if ev.SeverityID != 5 { // facility 4, severity 2 (Critical) -> OCSF Critical=5
		t.Errorf("SeverityID = %d, want 5", ev.SeverityID)
	}
	if ev.Metadata["hostname"] != "host1" {
		t.Errorf("Metadata[hostname] = %q, want host1", ev.Metadata["hostname"])
	}
	if ev.Metadata["app_name"] != "sshd" {
		t.Errorf("Metadata[app_name] = %q, want sshd", ev.Metadata["app_name"])
	}
	if ev.Unmapped["structured_data"] != `[meta@1 x="1"]` {
		t.Errorf("Unmapped[structured_data] = %q", ev.Unmapped["structured_data"])
	}
	if ev.Unmapped["msg"] != "login failed" {
		t.Errorf("Unmapped[msg] = %q", ev.Unmapped["msg"])
	}
	if ev.TimeUnixMillis != 1704067200000 {
		t.Errorf("TimeUnixMillis = %d, want 1704067200000 (2024-01-01T00:00:00Z)", ev.TimeUnixMillis)
	}
}

// T2's own cursor-restart analogue to M365's T2: a brand-new Connector
// instance over the SAME underlying listener (as a real restart of the
// consuming side, but not the listener process itself, would look like),
// given the previously committed cursor, must not re-deliver what was
// already fetched.
func TestSyslogConnector_RestartResumesWithoutDuplication(t *testing.T) {
	listener := newTestListener(t)
	sendLines(t, listener.Addr(), `<14>1 2024-01-01T00:00:00Z host app - - - first`)

	deadline := time.Now().Add(2 * time.Second)
	for listener.buf.len() < 1 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}

	conn1 := NewConnector(testTenantID, listener)
	batch1, cur1, err := conn1.Fetch(context.Background(), nil)
	if err != nil {
		t.Fatalf("first Fetch: %v", err)
	}
	if len(batch1.Events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(batch1.Events))
	}

	sendLines(t, listener.Addr(), `<14>1 2024-01-01T00:00:01Z host app - - - second`)
	deadline = time.Now().Add(2 * time.Second)
	for listener.buf.len() < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}

	conn2 := NewConnector(testTenantID, listener) // a fresh instance, same listener/buffer
	batch2, _, err := conn2.Fetch(context.Background(), cur1)
	if err != nil {
		t.Fatalf("second Fetch: %v", err)
	}
	if len(batch2.Events) != 1 {
		t.Fatalf("expected exactly 1 NEW event after resuming from the committed cursor, got %d", len(batch2.Events))
	}
}

// Malformed input at Normalise time (bypassing the listener's own
// pre-filter, as a hand-crafted RawEvent in a unit test can) still
// produces a valid, groundable event rather than erroring — the
// developer guide's "no acceptable way to just drop data" rule.
func TestSyslogConnector_NormaliseIsTotal(t *testing.T) {
	conn := &Connector{tenantID: testTenantID, now: time.Now}
	events, err := conn.Normalise(rawEventFor(testTenantID, []byte("not a syslog line")))
	if err != nil {
		t.Fatalf("Normalise returned an error for malformed input, want total: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].EventID == "" {
		t.Error("expected a non-empty event_id even for malformed input")
	}
	if events[0].Unmapped["_raw"] != "not a syslog line" {
		t.Errorf("Unmapped[_raw] = %q", events[0].Unmapped["_raw"])
	}
}

func TestSyslogConnector_EventIDIsDeterministic(t *testing.T) {
	conn := &Connector{tenantID: testTenantID, now: time.Now}
	raw := rawEventFor(testTenantID, []byte(`<14>1 2024-01-01T00:00:00Z host app - - - hello`))
	first, err := conn.Normalise(raw)
	if err != nil {
		t.Fatalf("Normalise: %v", err)
	}
	for i := 0; i < 50; i++ {
		got, err := conn.Normalise(raw)
		if err != nil {
			t.Fatalf("Normalise: %v", err)
		}
		if got[0].EventID != first[0].EventID {
			t.Fatalf("event_id changed across repeated invocations: %q vs %q", got[0].EventID, first[0].EventID)
		}
	}
}

func rawEventFor(tenantID string, payload []byte) sentinelconnector.RawEvent {
	return sentinelconnector.RawEvent{TenantID: tenantID, Payload: payload, FetchedAt: time.Now().Unix()}
}
