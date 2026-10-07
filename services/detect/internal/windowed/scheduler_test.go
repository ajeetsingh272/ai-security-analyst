package windowed

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

func TestLevelInterval(t *testing.T) {
	cases := map[string]time.Duration{
		"critical": 30 * time.Second,
		"high":     30 * time.Second,
		"medium":   5 * time.Minute,
		"low":      15 * time.Minute,
		"":         15 * time.Minute,
	}
	for level, want := range cases {
		if got := levelInterval(level); got != want {
			t.Errorf("levelInterval(%q) = %v, want %v", level, got, want)
		}
	}
}

func TestEntityTypeFromGroupField(t *testing.T) {
	cases := map[string]string{
		"UserId":   "user",
		"ClientIP": "clientip",
		"UserID":   "user",
	}
	for field, want := range cases {
		if got := entityTypeFromGroupField(field); got != want {
			t.Errorf("entityTypeFromGroupField(%q) = %q, want %q", field, got, want)
		}
	}
}

// fakeConn implements driver.Conn by embedding it as nil and overriding
// only Query — the one method runOnce actually calls. Any other method
// call would panic, which is fine: no test here exercises one.
type fakeConn struct {
	driver.Conn
	queryFn func(ctx context.Context, query string, args ...any) (driver.Rows, error)
}

func (f *fakeConn) Query(ctx context.Context, query string, args ...any) (driver.Rows, error) {
	return f.queryFn(ctx, query, args...)
}

// lockingHandler captures log records so a test can assert on them —
// slog.Logger itself is safe for concurrent use, but the records slice
// this Handler appends to needs its own lock since runLoop's goroutines
// could in principle log concurrently.
type lockingHandler struct {
	mu   sync.Mutex
	msgs []string
}

func (h *lockingHandler) Enabled(context.Context, slog.Level) bool { return true }
func (h *lockingHandler) Handle(_ context.Context, r slog.Record) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.msgs = append(h.msgs, r.Message)
	return nil
}
func (h *lockingHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *lockingHandler) WithGroup(string) slog.Handler      { return h }

func (h *lockingHandler) contains(substr string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, m := range h.msgs {
		if strings.Contains(m, substr) {
			return true
		}
	}
	return false
}

// fakeRows implements driver.Rows over an in-memory row set, enough for
// scanSignals' own four-column Scan(&tenantID, &groupKey, &aggValue,
// &eventIDs) call — not a general-purpose fake.
type fakeRow struct {
	tenantID, groupKey string
	aggValue           uint64
	eventIDs           []string
}

type fakeRows struct {
	driver.Rows
	rows []fakeRow
	i    int
}

func (f *fakeRows) Next() bool {
	if f.i >= len(f.rows) {
		return false
	}
	f.i++
	return true
}

func (f *fakeRows) Scan(dest ...any) error {
	r := f.rows[f.i-1]
	*dest[0].(*string) = r.tenantID
	*dest[1].(*string) = r.groupKey
	*dest[2].(*uint64) = r.aggValue
	*dest[3].(*[]string) = r.eventIDs
	return nil
}

func (f *fakeRows) Err() error   { return nil }
func (f *fakeRows) Close() error { return nil }

func TestScanSignals_BuildsOneSignalPerRow(t *testing.T) {
	r := parseRule(t, "impossible-travel")
	rows := &fakeRows{rows: []fakeRow{
		{tenantID: "tenant-a", groupKey: "alice", aggValue: 2, eventIDs: []string{"evt-1", "evt-2"}},
		{tenantID: "tenant-b", groupKey: "bob", aggValue: 3, eventIDs: []string{"evt-3"}},
	}}
	now := time.Now().UTC()

	signals, err := scanSignals(rows, r, now)
	if err != nil {
		t.Fatalf("scanSignals: %v", err)
	}
	if len(signals) != 2 {
		t.Fatalf("got %d signals, want 2: %+v", len(signals), signals)
	}

	a := signals[0]
	if a.TenantID != "tenant-a" || a.EntityID != "alice" || a.EntityType != "user" {
		t.Errorf("signal 0 = %+v, want tenant-a/alice/user", a)
	}
	if len(a.EventIDs) != 2 || a.EventIDs[0] != "evt-1" || a.EventIDs[1] != "evt-2" {
		t.Errorf("signal 0 EventIDs = %v, want [evt-1 evt-2]", a.EventIDs)
	}
	if a.RuleID != r.ID || a.Engine != "windowed" || a.Severity != r.Level {
		t.Errorf("signal 0 = %+v, want RuleID=%s Engine=windowed Severity=%s", a, r.ID, r.Level)
	}
	if len(a.MitreIDs) == 0 {
		t.Errorf("signal 0 MitreIDs is empty, want the rule's own MITRE tags")
	}

	b := signals[1]
	if b.TenantID != "tenant-b" || b.EntityID != "bob" {
		t.Errorf("signal 1 = %+v, want tenant-b/bob", b)
	}
}

func TestScanSignals_NoRowsProducesNoSignals(t *testing.T) {
	r := parseRule(t, "mass-mailbox-download")
	rows := &fakeRows{}
	signals, err := scanSignals(rows, r, time.Now())
	if err != nil {
		t.Fatalf("scanSignals: %v", err)
	}
	if len(signals) != 0 {
		t.Fatalf("got %d signals, want 0", len(signals))
	}
}

// T4: a long-running query is killed at its budget and raises an alert.
// The fake connection's Query blocks until its context is cancelled
// (the generic shape of "this query is taking too long"), proving
// runOnce's own context.WithTimeout actually bounds it rather than
// waiting forever, and that the kill is logged rather than silently
// swallowed.
func TestRunOnce_KillsSlowQueryAtBudget(t *testing.T) {
	r := parseRule(t, "mass-mailbox-download")
	q, err := BuildQuery(r)
	if err != nil {
		t.Fatalf("BuildQuery: %v", err)
	}

	conn := &fakeConn{queryFn: func(ctx context.Context, _ string, _ ...any) (driver.Rows, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}}
	handler := &lockingHandler{}
	s := &Scheduler{conn: conn, log: slog.New(handler)}

	start := time.Now()
	const budget = 50 * time.Millisecond
	s.runOnce(context.Background(), scheduledRule{query: q, interval: budget})
	elapsed := time.Since(start)

	if elapsed > budget+2*time.Second {
		t.Fatalf("runOnce took %v, want bounded close to the %v budget (it should have been killed, not run indefinitely)", elapsed, budget)
	}
	if !handler.contains("windowed rule killed") {
		t.Fatalf("expected a \"windowed rule killed\" log line, got: %v", handler.msgs)
	}
}

// A query that fails for an ordinary (non-timeout) reason is logged
// differently and, critically, does not hang or panic — the scheduler's
// own ticker loop (not exercised directly here, see runLoop) must be
// able to continue to its next tick regardless of how this run ended.
func TestRunOnce_OrdinaryQueryErrorIsLoggedNotKilled(t *testing.T) {
	r := parseRule(t, "impossible-travel")
	q, err := BuildQuery(r)
	if err != nil {
		t.Fatalf("BuildQuery: %v", err)
	}

	conn := &fakeConn{queryFn: func(context.Context, string, ...any) (driver.Rows, error) {
		return nil, fmt.Errorf("connection refused")
	}}
	handler := &lockingHandler{}
	s := &Scheduler{conn: conn, log: slog.New(handler)}

	s.runOnce(context.Background(), scheduledRule{query: q, interval: time.Second})

	if !handler.contains("windowed rule query failed") {
		t.Fatalf("expected a \"windowed rule query failed\" log line, got: %v", handler.msgs)
	}
	if handler.contains("windowed rule killed") {
		t.Fatalf("an ordinary query error must not be logged as a budget kill: %v", handler.msgs)
	}
}
