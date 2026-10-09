package google

import (
	"encoding/json"
	"testing"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/m365"
)

const goldenTenantID = "44444444-4444-4444-8444-444444444444"

func wrapRecord(t *testing.T, item map[string]any, eventIndex int) []byte {
	t.Helper()
	itemBytes, err := json.Marshal(item)
	if err != nil {
		t.Fatalf("marshalling item: %v", err)
	}
	rec := rawEventRecord{Item: itemBytes, EventIndex: eventIndex}
	b, err := json.Marshal(rec)
	if err != nil {
		t.Fatalf("marshalling record: %v", err)
	}
	return b
}

func loginItem(uniqueQualifier, time, actorEmail, eventName string) map[string]any {
	return map[string]any{
		"id": map[string]any{
			"time":            time,
			"uniqueQualifier": uniqueQualifier,
			"applicationName": "login",
		},
		"actor":     map[string]any{"email": actorEmail},
		"ipAddress": "203.0.113.5",
		"events":    []map[string]any{{"type": "login", "name": eventName}},
	}
}

// T1/T2: golden fixtures per activityMappings family, byte for byte on the
// (class, category, activity, type) tuple — mirrors
// m365/ocsf_mapping_test.go's own TestMapM365Event_GoldenFixturesPerFamily.
func TestMapGoogleEvent_GoldenFixturesPerFamily(t *testing.T) {
	cases := []struct {
		name                            string
		applicationName, uniqueQ, time  string
		eventName                       string
		wantClassUID, wantCat, wantActy int64
	}{
		{"sign-in", "login", "sign-in-1", "2024-01-01T00:00:00.000Z", "login_success", 3002, 3, 1},
		{"sign-in failure", "login", "sign-in-2", "2024-01-01T00:00:00.000Z", "login_failure", 3002, 3, 1},
		{"logout", "login", "logout-1", "2024-01-01T00:00:00.000Z", "logout", 3002, 3, 2},
		{"admin create user", "admin", "admin-1", "2024-01-01T00:00:00.000Z", "CREATE_USER", 3001, 3, 1},
		{"admin delete user", "admin", "admin-2", "2024-01-01T00:00:00.000Z", "DELETE_USER", 3001, 3, 6},
		{"group add member", "admin", "group-1", "2024-01-01T00:00:00.000Z", "ADD_GROUP_MEMBER", 3006, 3, 3},
		{"group delete", "admin", "group-2", "2024-01-01T00:00:00.000Z", "DELETE_GROUP", 3006, 3, 5},
		{"drive download", "drive", "drive-1", "2024-01-01T00:00:00.000Z", "download", 6006, 6, 2},
		{"drive view", "drive", "drive-2", "2024-01-01T00:00:00.000Z", "view", 6006, 6, 14},
		{"token authorize", "token", "token-1", "2024-01-01T00:00:00.000Z", "authorize", 3005, 3, 1},
		{"token revoke", "token", "token-2", "2024-01-01T00:00:00.000Z", "revoke", 3005, 3, 2},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			item := loginItem(tc.uniqueQ, tc.time, "alice@example.com", tc.eventName)
			item["id"].(map[string]any)["applicationName"] = tc.applicationName
			raw := wrapRecord(t, item, 0)

			ev := MapEvent(goldenTenantID, tc.applicationName, raw, 1704067200)
			if ev.ClassUID != tc.wantClassUID || ev.CategoryUID != tc.wantCat || ev.ActivityID != tc.wantActy {
				t.Fatalf("got (class=%d, category=%d, activity=%d), want (class=%d, category=%d, activity=%d)",
					ev.ClassUID, ev.CategoryUID, ev.ActivityID, tc.wantClassUID, tc.wantCat, tc.wantActy)
			}
			if ev.TypeUID != tc.wantClassUID*100+tc.wantActy {
				t.Fatalf("TypeUID = %d, want %d", ev.TypeUID, tc.wantClassUID*100+tc.wantActy)
			}
			if ev.SchemaVersion != SchemaVersion {
				t.Fatalf("SchemaVersion = %q, want %q", ev.SchemaVersion, SchemaVersion)
			}
			if ev.Metadata["product"] != "google_workspace" {
				t.Fatalf(`Metadata["product"] = %q, want "google_workspace"`, ev.Metadata["product"])
			}
			if ev.Metadata["operation"] != tc.eventName {
				t.Fatalf(`Metadata["operation"] = %q, want %q`, ev.Metadata["operation"], tc.eventName)
			}
			if ev.Unmapped["actorEmail"] != "alice@example.com" {
				t.Fatalf("expected actorEmail preserved under Unmapped, got %+v", ev.Unmapped)
			}
			if _, leaked := ev.Unmapped["eventName"]; leaked {
				t.Fatalf("eventName should NOT appear in Unmapped once mapped, got %+v", ev.Unmapped)
			}
		})
	}
}

// T2 proper: the ticket's own acceptance criterion — "OCSF normalisation
// produces output equivalent to M365 for comparable events" — proven here
// by calling BOTH packages' MapEvent on their own vendor-shaped sign-in
// event and asserting the (class, category, activity, type) tuple is
// IDENTICAL, not merely individually plausible. Metadata["product"] is
// deliberately asserted to DIFFER (see ocsf_mapping.go's own doc comment on
// why "equivalent OCSF shape" never means identical product tag).
func TestMapGoogleEvent_SignInEquivalentToM365(t *testing.T) {
	googleItem := loginItem("g-sign-in-1", "2024-01-01T00:00:00.000Z", "alice@example.com", "login_success")
	googleRaw := wrapRecord(t, googleItem, 0)
	googleEv := MapEvent(goldenTenantID, "login", googleRaw, 1704067200)

	m365Raw, err := json.Marshal(map[string]string{
		"Id": "m-sign-in-1", "CreationTime": "2024-01-01T00:00:00Z", "Operation": "UserLoggedIn", "UserId": "alice@contoso.com",
	})
	if err != nil {
		t.Fatalf("marshalling m365 record: %v", err)
	}
	m365Ev := m365.MapEvent(goldenTenantID, "Audit.AzureActiveDirectory", m365Raw, 1704067200)

	if googleEv.ClassUID != m365Ev.ClassUID || googleEv.CategoryUID != m365Ev.CategoryUID || googleEv.ActivityID != m365Ev.ActivityID {
		t.Fatalf("Google sign-in (class=%d,cat=%d,act=%d) is not equivalent to M365 sign-in (class=%d,cat=%d,act=%d)",
			googleEv.ClassUID, googleEv.CategoryUID, googleEv.ActivityID, m365Ev.ClassUID, m365Ev.CategoryUID, m365Ev.ActivityID)
	}
	if googleEv.TypeUID != m365Ev.TypeUID {
		t.Fatalf("TypeUID mismatch: google=%d m365=%d", googleEv.TypeUID, m365Ev.TypeUID)
	}
	if googleEv.Metadata["product"] == m365Ev.Metadata["product"] {
		t.Fatalf("expected distinct product tags (each connector stamps its own vendor), got both %q", googleEv.Metadata["product"])
	}
}

// Gmail's own special case: eventName is always the literal "delivery",
// with the real activity carried in the mail_event_type parameter.
func TestMapGoogleEvent_GmailMailEventType(t *testing.T) {
	item := map[string]any{
		"id":        map[string]any{"time": "2024-01-01T00:00:00.000Z", "uniqueQualifier": "gmail-1", "applicationName": "gmail"},
		"actor":     map[string]any{"email": "bob@example.com"},
		"ipAddress": "203.0.113.9",
		"events": []map[string]any{{
			"type": "email_delivery_events", "name": "delivery",
			"parameters": []map[string]any{{"name": "mail_event_type", "intValue": "1"}},
		}},
	}
	raw := wrapRecord(t, item, 0)
	ev := MapEvent(goldenTenantID, "gmail", raw, 1704067200)

	if ev.ClassUID != 4009 || ev.CategoryUID != 4 || ev.ActivityID != 1 {
		t.Fatalf("expected Email Activity Send (4009,4,1) for mail_event_type=1, got (%d,%d,%d)", ev.ClassUID, ev.CategoryUID, ev.ActivityID)
	}
	if ev.Unmapped["mail_event_type"] != "1" {
		t.Fatalf("expected mail_event_type preserved under Unmapped, got %+v", ev.Unmapped)
	}
}

// AC1's "pure, total" taken to its limit: an unknown event, a gmail event
// with no recognised mail_event_type, and unparsable bytes must all still
// produce a valid, groundable event rather than erroring or panicking.
func TestMapGoogleEvent_UnknownAndUnparsableAreNeverDropped(t *testing.T) {
	t.Run("unrecognised event name", func(t *testing.T) {
		item := loginItem("unknown-1", "2024-01-01T00:00:00.000Z", "eve@example.com", "some_future_event_nobody_mapped_yet")
		raw := wrapRecord(t, item, 0)
		ev := MapEvent(goldenTenantID, "login", raw, 1704067200)
		if ev.ClassUID != 0 {
			t.Fatalf("expected class_uid 0 for an unrecognised event, got %d", ev.ClassUID)
		}
		if ev.EventID == "" {
			t.Fatal("expected a non-empty event_id even for an unrecognised event")
		}
		if ev.Unmapped["eventName"] != "some_future_event_nobody_mapped_yet" {
			t.Fatalf("expected the unrecognised eventName preserved under Unmapped, got %+v", ev.Unmapped)
		}
	})

	t.Run("gmail with no mail_event_type parameter", func(t *testing.T) {
		item := map[string]any{
			"id":     map[string]any{"time": "2024-01-01T00:00:00.000Z", "uniqueQualifier": "gmail-2", "applicationName": "gmail"},
			"events": []map[string]any{{"type": "email_delivery_events", "name": "delivery"}},
		}
		raw := wrapRecord(t, item, 0)
		ev := MapEvent(goldenTenantID, "gmail", raw, 1704067200)
		if ev.ClassUID != 0 {
			t.Fatalf("expected class_uid 0 when mail_event_type is absent, got %d", ev.ClassUID)
		}
	})

	t.Run("unparsable bytes", func(t *testing.T) {
		garbage := []byte(`{not json at all`)
		ev := MapEvent(goldenTenantID, "login", garbage, 1704067200)
		if ev.ClassUID != 0 {
			t.Fatalf("expected class_uid 0 for unparsable input, got %d", ev.ClassUID)
		}
		if ev.EventID == "" {
			t.Fatal("expected a non-empty, deterministic event_id even for unparsable input")
		}
		if ev.Unmapped["_raw"] != string(garbage) {
			t.Fatalf("expected raw bytes preserved under Unmapped[_raw], got %+v", ev.Unmapped)
		}
		if string(ev.RawData) != string(garbage) {
			t.Fatal("expected RawData to still hold the exact original bytes")
		}
	})
}

// Determinism property test — same discipline as m365's own 200x check.
func TestMapGoogleEvent_DeterministicAcrossRepeatedInvocations(t *testing.T) {
	item := loginItem("det-1", "2024-06-15T10:30:00.000+05:30", "frank@example.com", "download")
	item["id"].(map[string]any)["applicationName"] = "drive"
	raw := wrapRecord(t, item, 0)

	var first string
	for i := 0; i < 200; i++ {
		ev := MapEvent(goldenTenantID, "drive", raw, int64(1700000000+i))
		if i == 0 {
			first = ev.EventID
			continue
		}
		if ev.EventID != first {
			t.Fatalf("invocation %d produced a different event_id (%q) than the first (%q)", i, ev.EventID, first)
		}
	}
}

func TestCoverageReport_CoversAllFiveGoogleEventFamilies(t *testing.T) {
	report := CoverageReport()
	if len(report) == 0 {
		t.Fatal("expected a non-empty coverage report")
	}
	seenClassUIDs := map[int64]bool{}
	for _, entry := range report {
		seenClassUIDs[entry.ClassUID] = true
	}
	for _, want := range []int64{3002, 3001, 3006, 6006, 3005, 4009} {
		if !seenClassUIDs[want] {
			t.Fatalf("coverage report is missing class_uid %d", want)
		}
	}
}
