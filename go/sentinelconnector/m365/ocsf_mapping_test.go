package m365

import (
	"testing"
)

const goldenTenantID = "33333333-3333-4333-8333-333333333333"

func exchangeAuditRecord(id, creationTime, operation, extra string) []byte {
	return []byte(`{"Id":"` + id + `","CreationTime":"` + creationTime + `","Operation":"` + operation + `","UserId":"` + extra + `"}`)
}

// T1: "Golden fixture per event family maps to the expected OCSF output,
// byte for byte." One fixture per ADR-0002 family (sign-in, mailbox, file,
// admin, consent) — class_uid/category_uid/activity_id/type_uid are
// verified against the live OCSF 1.3.0 schema (see ocsf_mapping.go's own
// doc comment), and event_id is asserted against a hardcoded golden value
// computed once from this exact fixture, so a change to the ID algorithm
// that silently shifts every id would fail this test, not just a
// self-consistency check against its own output.
func TestMapM365Event_GoldenFixturesPerFamily(t *testing.T) {
	cases := []struct {
		name         string
		contentType  string
		record       []byte
		wantClassUID int64
		wantCatUID   int64
		wantActivity int64
		wantTypeUID  int64
		wantEventID  string
	}{
		{
			name:         "sign-in",
			contentType:  "Audit.AzureActiveDirectory",
			record:       exchangeAuditRecord("sign-in-1", "2024-01-01T00:00:00Z", "UserLoggedIn", "alice@contoso.com"),
			wantClassUID: 3002, wantCatUID: 3, wantActivity: 1, wantTypeUID: 300201,
			wantEventID: "evt_ce5ecfc8-9649-56b4-9091-d0bf8eb8a958",
		},
		{
			name:         "mailbox",
			contentType:  "Audit.Exchange",
			record:       exchangeAuditRecord("mailbox-1", "2024-01-01T00:00:00Z", "Send", "bob@contoso.com"),
			wantClassUID: 4009, wantCatUID: 4, wantActivity: 1, wantTypeUID: 400901,
			wantEventID: "evt_a88d9330-759c-5469-bbf4-46fc637c506d",
		},
		{
			name:         "file",
			contentType:  "Audit.SharePoint",
			record:       exchangeAuditRecord("file-1", "2024-01-01T00:00:00Z", "FileUploaded", "carol@contoso.com"),
			wantClassUID: 6006, wantCatUID: 6, wantActivity: 1, wantTypeUID: 600601,
			wantEventID: "evt_29e1c831-3429-54b0-a600-803d83864336",
		},
		{
			name:         "admin",
			contentType:  "Audit.AzureActiveDirectory",
			record:       exchangeAuditRecord("admin-1", "2024-01-01T00:00:00Z", "Add user.", "admin@contoso.com"),
			wantClassUID: 3001, wantCatUID: 3, wantActivity: 1, wantTypeUID: 300101,
			wantEventID: "evt_0e43f78e-9844-5640-853d-898cbc878a6e",
		},
		{
			name:         "consent",
			contentType:  "Audit.AzureActiveDirectory",
			record:       exchangeAuditRecord("consent-1", "2024-01-01T00:00:00Z", "Consent to application.", "dave@contoso.com"),
			wantClassUID: 3005, wantCatUID: 3, wantActivity: 1, wantTypeUID: 300501,
			wantEventID: "evt_23de305d-5a99-549a-ad4b-d3ac2c676d0d",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ev := MapEvent(goldenTenantID, tc.contentType, tc.record, 1704067200)

			if ev.ClassUID != tc.wantClassUID || ev.CategoryUID != tc.wantCatUID || ev.ActivityID != tc.wantActivity {
				t.Fatalf("got (class=%d, category=%d, activity=%d), want (class=%d, category=%d, activity=%d)",
					ev.ClassUID, ev.CategoryUID, ev.ActivityID, tc.wantClassUID, tc.wantCatUID, tc.wantActivity)
			}
			if ev.TypeUID != tc.wantTypeUID {
				t.Fatalf("TypeUID = %d, want %d (class_uid*100 + activity_id)", ev.TypeUID, tc.wantTypeUID)
			}
			if ev.EventID != tc.wantEventID {
				t.Fatalf("EventID = %q, want golden value %q", ev.EventID, tc.wantEventID)
			}
			if ev.SchemaVersion != SchemaVersion {
				t.Fatalf("SchemaVersion = %q, want %q", ev.SchemaVersion, SchemaVersion)
			}
			if ev.TenantID != goldenTenantID {
				t.Fatalf("TenantID = %q, want %q", ev.TenantID, goldenTenantID)
			}
			if ev.TimeUnixMillis != 1704067200000 {
				t.Fatalf("TimeUnixMillis = %d, want %d (2024-01-01T00:00:00Z)", ev.TimeUnixMillis, 1704067200000)
			}
			if _, stillPresent := ev.Unmapped["UserId"]; !stillPresent {
				t.Fatalf("expected UserId to be preserved under Unmapped, got %+v", ev.Unmapped)
			}
			if _, leaked := ev.Unmapped["Operation"]; leaked {
				t.Fatalf("Operation should NOT appear in Unmapped once mapped (it's represented structurally), got %+v", ev.Unmapped)
			}
		})
	}
}

// T2: "Unknown event type is preserved rather than dropped or erroring."
func TestMapM365Event_UnknownOperationIsPreservedNotDropped(t *testing.T) {
	record := exchangeAuditRecord("unknown-1", "2024-01-01T00:00:00Z", "SomeFutureOperationNobodyMappedYet", "eve@contoso.com")
	ev := MapEvent(goldenTenantID, "Audit.General", record, 1704067200)

	if ev.ClassUID != 0 || ev.CategoryUID != 0 || ev.ActivityID != 0 {
		t.Fatalf("expected an unrecognised operation to map to class_uid 0 (uncategorized), got (%d,%d,%d)", ev.ClassUID, ev.CategoryUID, ev.ActivityID)
	}
	if ev.EventID == "" {
		t.Fatal("expected a non-empty event_id even for an unrecognised operation")
	}
	got, ok := ev.Unmapped["Operation"]
	if !ok {
		t.Fatalf("expected the unrecognised Operation value to be preserved under Unmapped, got %+v", ev.Unmapped)
	}
	if got != "SomeFutureOperationNobodyMappedYet" {
		t.Fatalf("Unmapped[Operation] = %q, want the original operation name", got)
	}
	if string(ev.RawData) != string(record) {
		t.Fatal("expected RawData to still hold the exact original bytes")
	}
}

// A payload that isn't even valid JSON must still produce a valid event —
// AC1's "pure, total" taken to its actual limit, not just "handles the
// happy path and the one documented unknown-operation case."
func TestMapM365Event_UnparsableRecordStillProducesAnEvent(t *testing.T) {
	garbage := []byte(`{not json at all`)
	ev := MapEvent(goldenTenantID, "Audit.General", garbage, 1704067200)

	if ev.ClassUID != 0 {
		t.Fatalf("expected class_uid 0 for unparsable input, got %d", ev.ClassUID)
	}
	if ev.EventID == "" {
		t.Fatal("expected a non-empty, deterministic event_id even for unparsable input")
	}
	if ev.Unmapped["_raw"] != string(garbage) {
		t.Fatalf("expected the raw bytes preserved under Unmapped[_raw], got %+v", ev.Unmapped)
	}
	if string(ev.RawData) != string(garbage) {
		t.Fatal("expected RawData to still hold the exact original bytes")
	}
}

// T3: "Property test: normalisation is deterministic across repeated
// invocations." Run the same input through MapEvent many times (and
// through a brand new process-equivalent state each time — this package
// has no global mutable state to even reset) and require byte-identical
// EventID every time.
func TestMapM365Event_DeterministicAcrossRepeatedInvocations(t *testing.T) {
	record := exchangeAuditRecord("det-1", "2024-06-15T10:30:00+05:30", "FileDownloaded", "frank@contoso.com")

	var first string
	for i := 0; i < 200; i++ {
		ev := MapEvent(goldenTenantID, "Audit.SharePoint", record, int64(1700000000+i)) // FetchedAt varies — must NOT affect EventID
		if i == 0 {
			first = ev.EventID
			continue
		}
		if ev.EventID != first {
			t.Fatalf("invocation %d produced a different event_id (%q) than the first (%q) for the identical record", i, ev.EventID, first)
		}
		if ev.TimeUnixMillis != 1718427600000 {
			t.Fatalf("invocation %d: TimeUnixMillis = %d, want the record's own CreationTime regardless of FetchedAt", i, ev.TimeUnixMillis)
		}
	}
}

// T4: "Timezone handling is correct for events in non-UTC offsets,
// including DST boundaries."
func TestMapM365Event_TimezoneHandling(t *testing.T) {
	cases := []struct {
		name           string
		creationTime   string
		wantUnixMillis int64
		wantOffset     string
	}{
		{"UTC Z", "2024-01-01T00:00:00Z", 1704067200000, "Z"},
		{"positive offset +05:30 (IST)", "2024-01-01T05:30:00+05:30", 1704067200000, "+05:30"},
		{"negative offset -08:00 (PST)", "2023-12-31T16:00:00-08:00", 1704067200000, "-08:00"},
		// US DST spring-forward 2024: clocks jump from -08:00 (PST) to
		// -07:00 (PDT) at 2024-03-10T02:00:00 local. 2024-03-10T03:30:00-07:00
		// is a real, valid local time just after the jump.
		{"DST spring-forward boundary (PDT, -07:00)", "2024-03-10T03:30:00-07:00", 1710066600000, "-07:00"},
		// US DST fall-back 2023: 2023-11-05T01:30:00-07:00 (still PDT,
		// before the 2am rollback) vs -08:00 (PST, after it) are two
		// DIFFERENT real instants that share the same local wall-clock
		// reading — proving this isn't just string-parsing the offset but
		// actually using it to compute the correct UTC instant.
		{"DST fall-back, pre-rollback (-07:00)", "2023-11-05T01:30:00-07:00", 1699173000000, "-07:00"},
		{"DST fall-back, post-rollback (-08:00)", "2023-11-05T01:30:00-08:00", 1699176600000, "-08:00"},
		{"no offset at all (M365's real CreationTime format — implicitly UTC)", "2024-01-01T00:00:00", 1704067200000, "Z"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			record := exchangeAuditRecord("tz-1", tc.creationTime, "FileAccessed", "grace@contoso.com")
			ev := MapEvent(goldenTenantID, "Audit.SharePoint", record, 0)

			if ev.TimeUnixMillis != tc.wantUnixMillis {
				t.Fatalf("TimeUnixMillis = %d, want %d", ev.TimeUnixMillis, tc.wantUnixMillis)
			}
			if ev.TimeOffset != tc.wantOffset {
				t.Fatalf("TimeOffset = %q, want %q (the original offset must be retained, not just normalised away)", ev.TimeOffset, tc.wantOffset)
			}
		})
	}
}

func TestCoverageReport_CoversAllFiveM365EventFamilies(t *testing.T) {
	report := CoverageReport()
	if len(report) == 0 {
		t.Fatal("expected a non-empty coverage report")
	}
	seenClassUIDs := map[int64]bool{}
	for _, entry := range report {
		seenClassUIDs[entry.ClassUID] = true
	}
	// Authentication (sign-in), Email Activity (mailbox), File Hosting
	// Activity (file), Account Change + Group Management (admin), User
	// Access Management (consent) — ADR-0002's five named families.
	for _, want := range []int64{3002, 4009, 6006, 3001, 3006, 3005} {
		if !seenClassUIDs[want] {
			t.Fatalf("coverage report is missing class_uid %d — ADR-0002's five families require it", want)
		}
	}
}
