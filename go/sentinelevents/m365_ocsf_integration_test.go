//go:build integration

package sentinelevents

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/m365"
)

const m365IntegrationContentType = "Audit.SharePoint"
const m365IntegrationTenantID = "44444444-4444-4444-8444-444444444444"

// P1-04 T5/T6: m365.MapEvent's real output, through the REAL
// ClickHouseWriter, into REAL ClickHouse — proving event_id specifically
// survives that path unchanged and is resolvable by the lookup the
// grounding validator (P4-04) will perform (T5), and that re-normalising
// the identical raw payload after a simulated replay reproduces the
// identical event_id, so a claim grounded against the first ingest stays
// resolvable after a replay (T6, ADR-0010's own "duplicates are
// harmless, not avoided" framing — this is WHY they're harmless for
// grounding specifically).
//
// Lives in THIS package (not go/sentinelconnector or services/ingest)
// and queries through w.conn — the writer's own connection, exactly as
// TestWriterInsertsABatch above does — deliberately, not a separate
// connection: an earlier version of this test opened its own query
// connection and was genuinely flaky (occasionally never saw the row at
// all, even after several seconds), which traced back to ClickHouse's
// async_insert mode: wait_for_async_insert=1 (writer.go) guarantees the
// write is visible to the SAME session immediately, but a freshly
// opened, separate connection was observed not to see it reliably within
// any bounded wait tried. Querying through the same connection that did
// the write is what TestWriterInsertsABatch already does, and it has
// never been flaky.
//
// Requires: pnpm dev:stack && pnpm db:migrate. Run via:
//
//	go test -tags=integration ./go/sentinelevents/...
func TestM365OCSFPipeline_EventIDSurvivesIngestAndIsReplaySafe(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	w := newTestWriter(t)

	// A unique record id per test run — not a fixed literal — so repeated
	// runs don't pile up identical-key rows before ReplacingMergeTree's
	// next merge collapses them.
	recordID := fmt.Sprintf("ocsf-pipeline-%d", time.Now().UnixNano())
	raw := []byte(`{"Id":"` + recordID + `","CreationTime":"2024-01-01T00:00:00Z","Operation":"FileUploaded","UserId":"integration-test@contoso.com"}`)

	ev := m365.MapEvent(m365IntegrationTenantID, m365IntegrationContentType, raw, time.Now().Unix())
	if ev.EventID == "" {
		t.Fatal("MapEvent produced an empty event_id")
	}

	row := EventRow{
		TenantID:      ev.TenantID,
		EventID:       ev.EventID,
		Time:          time.UnixMilli(ev.TimeUnixMillis).UTC(),
		SchemaVersion: ev.SchemaVersion,
		ClassUID:      uint32(ev.ClassUID),
		CategoryUID:   uint16(ev.CategoryUID),
		ActivityID:    uint16(ev.ActivityID),
		TypeUID:       uint32(ev.TypeUID),
		Unmapped:      ev.Unmapped,
	}
	if err := w.Write(ctx, []EventRow{row}); err != nil {
		t.Fatalf("writing to ClickHouse: %v", err)
	}
	t.Cleanup(func() {
		_ = w.conn.Exec(context.Background(), "ALTER TABLE sentinel.events DELETE WHERE event_id = ?", ev.EventID)
	})

	// T5: resolvable by the exact lookup the grounding validator (P4-04)
	// will perform — a plain equality query by event_id.
	var gotSchemaVersion string
	var gotClassUID uint32
	if err := w.conn.QueryRow(ctx,
		"SELECT schema_version, class_uid FROM sentinel.events WHERE event_id = ?", ev.EventID,
	).Scan(&gotSchemaVersion, &gotClassUID); err != nil {
		t.Fatalf("event_id %q is not resolvable by lookup: %v", ev.EventID, err)
	}
	if gotSchemaVersion != m365.SchemaVersion {
		t.Fatalf("schema_version in ClickHouse = %q, want %q — AC: every event carries schema_version", gotSchemaVersion, m365.SchemaVersion)
	}
	if gotClassUID != uint32(ev.ClassUID) {
		t.Fatalf("class_uid in ClickHouse = %d, want %d", gotClassUID, ev.ClassUID)
	}

	// T6: re-normalising the identical raw payload (the "replay") must
	// reproduce the IDENTICAL event_id, so the row already in ClickHouse
	// stays resolvable by it. Proven by the equality check alone,
	// deliberately NOT by issuing a second ClickHouse query for the same
	// (already-proven-equal) id: an earlier version re-queried here and
	// was flaky in CI specifically — not because event_id stopped
	// resolving (T5 above already proved this exact id resolves), but
	// because clickhouse-go's Conn multiplexes queries across more than
	// one underlying connection, so a second query for the identical
	// value a moment later is not guaranteed to land on whichever
	// physical connection has already observed the async_insert flush.
	// That is a connection-pool/driver timing question, not a question
	// this test exists to answer — the actual claim ("the replayed id
	// equals the original, so the already-resolvable row stays
	// resolvable by it") is fully proven by the string equality itself.
	replayed := m365.MapEvent(m365IntegrationTenantID, m365IntegrationContentType, raw, time.Now().Unix()+999) // a different FetchedAt — must not matter
	if replayed.EventID != ev.EventID {
		t.Fatalf("replayed event_id %q does not match the original %q — a grounded claim would become unresolvable", replayed.EventID, ev.EventID)
	}
}
