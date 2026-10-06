//go:build integration

package sentinelevents

import (
	"context"
	"testing"
	"time"
)

// Requires: pnpm dev:stack && pnpm db:migrate. Run via:
//
//	go test -tags=integration ./...
func newTestWriter(t *testing.T) *ClickHouseWriter {
	t.Helper()
	w, err := NewClickHouseWriter("localhost:9000", "sentinel", "default", "")
	if err != nil {
		t.Fatalf("connecting to ClickHouse: %v", err)
	}
	t.Cleanup(func() { _ = w.Close() })
	return w
}

func TestWriterInsertsABatch(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	w := newTestWriter(t)

	tenantID := "11111111-1111-4111-8111-111111111111"
	rows := []EventRow{
		{
			TenantID: tenantID, EventID: "writer-test-1", Time: time.Now(),
			ClassUID: 3002, CategoryUID: 3, ActivityID: 1, TypeUID: 300201, SeverityID: 1,
			ActorUserUID: "u1", StatusID: 1, Message: "probe",
		},
		{
			TenantID: tenantID, EventID: "writer-test-2", Time: time.Now(),
			ClassUID: 3002, CategoryUID: 3, ActivityID: 1, TypeUID: 300201, SeverityID: 1,
			ActorUserUID: "u2", StatusID: 1, Message: "probe",
			Unmapped: map[string]string{"vendor_field": "vendor_value"},
		},
	}

	if err := w.Write(ctx, rows); err != nil {
		t.Fatalf("Write: %v", err)
	}
	t.Cleanup(func() {
		_ = w.conn.Exec(context.Background(), "ALTER TABLE sentinel.events DELETE WHERE event_id IN ('writer-test-1','writer-test-2')")
	})

	var count uint64
	if err := w.conn.QueryRow(ctx,
		"SELECT count() FROM sentinel.events WHERE event_id IN ('writer-test-1','writer-test-2')",
	).Scan(&count); err != nil {
		t.Fatalf("querying inserted rows: %v", err)
	}
	if count != 2 {
		t.Fatalf("expected 2 rows inserted, found %d", count)
	}

	var gotUnmapped map[string]string
	if err := w.conn.QueryRow(ctx,
		"SELECT unmapped FROM sentinel.events WHERE event_id = 'writer-test-2'",
	).Scan(&gotUnmapped); err != nil {
		t.Fatalf("querying unmapped map: %v", err)
	}
	if gotUnmapped["vendor_field"] != "vendor_value" {
		t.Fatalf("expected unmapped map to round-trip, got %v", gotUnmapped)
	}
}

// A single row ClickHouse rejects (here: a non-UUID tenant_id) must not
// block the rest of the batch — found the hard way by P1-07's own load
// test, where exactly this blocked every tenant's events behind one bad
// row forever. This proves the fix against the real server, not a mock of
// what the driver's error looks like.
func TestWriterDropsInvalidRowWithoutBlockingTheRest(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	w := newTestWriter(t)

	var dropped []EventRow
	w.OnInvalidRow(func(row EventRow, err error) { dropped = append(dropped, row) })

	validTenant := "11111111-1111-4111-8111-111111111111"
	rows := []EventRow{
		{TenantID: validTenant, EventID: "poison-valid-1", Time: time.Now(), ClassUID: 3002, CategoryUID: 3, ActivityID: 1, TypeUID: 300201, SeverityID: 1, StatusID: 1, Message: "ok"},
		{TenantID: "not-a-uuid", EventID: "poison-bad-1", Time: time.Now(), ClassUID: 3002, CategoryUID: 3, ActivityID: 1, TypeUID: 300201, SeverityID: 1, StatusID: 1, Message: "bad"},
		{TenantID: validTenant, EventID: "poison-valid-2", Time: time.Now(), ClassUID: 3002, CategoryUID: 3, ActivityID: 1, TypeUID: 300201, SeverityID: 1, StatusID: 1, Message: "ok"},
	}
	t.Cleanup(func() {
		_ = w.conn.Exec(context.Background(), "ALTER TABLE sentinel.events DELETE WHERE event_id IN ('poison-valid-1','poison-bad-1','poison-valid-2')")
	})

	if err := w.Write(ctx, rows); err != nil {
		t.Fatalf("Write: %v (the two valid rows should have succeeded despite the one bad row)", err)
	}

	if len(dropped) != 1 || dropped[0].EventID != "poison-bad-1" {
		t.Fatalf("expected exactly the bad row reported via OnInvalidRow, got %+v", dropped)
	}

	var count uint64
	if err := w.conn.QueryRow(ctx,
		"SELECT count() FROM sentinel.events WHERE event_id IN ('poison-valid-1','poison-valid-2')",
	).Scan(&count); err != nil {
		t.Fatalf("querying: %v", err)
	}
	if count != 2 {
		t.Fatalf("expected both valid rows written despite the bad one, got %d", count)
	}
}
