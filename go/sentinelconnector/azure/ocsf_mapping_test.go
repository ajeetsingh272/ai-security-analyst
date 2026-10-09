package azure

import (
	"encoding/json"
	"testing"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/m365"
)

const goldenTenantID = "99999999-9999-4999-8999-999999999999"

func entraRecordJSON(t *testing.T, category, operationName string, properties map[string]any) []byte {
	t.Helper()
	rec := map[string]any{
		"time":          "2024-01-01T00:00:00Z",
		"category":      category,
		"operationName": operationName,
		"properties":    properties,
	}
	b, err := json.Marshal(rec)
	if err != nil {
		t.Fatalf("marshalling fixture: %v", err)
	}
	return b
}

// T3-equivalent golden fixtures — one per family, mirroring m365/google/aws's own shape.
func TestMapEvent_GoldenFixturesPerFamily(t *testing.T) {
	cases := []struct {
		name                            string
		category, operationName         string
		properties                      map[string]any
		wantClassUID, wantCat, wantActy int64
	}{
		{"sign-in", "SignInLogs", "Sign-in activity", map[string]any{"id": "s1", "userPrincipalName": "alice@contoso.com", "resultType": "0"}, 3002, 3, 1},
		{"add user", "AuditLogs", "Add user", map[string]any{"id": "a1", "activityDisplayName": "Add user", "result": "success"}, 3001, 3, 1},
		{"delete user", "AuditLogs", "Delete user", map[string]any{"id": "a2", "activityDisplayName": "Delete user", "result": "success"}, 3001, 3, 6},
		{"add group member", "AuditLogs", "Add member to group", map[string]any{"id": "a3", "activityDisplayName": "Add member to group", "result": "success"}, 3006, 3, 3},
		{"consent", "AuditLogs", "Consent to application", map[string]any{"id": "a4", "activityDisplayName": "Consent to application", "result": "success"}, 3005, 3, 1},
		{"risk detection", "RiskDetections", "", map[string]any{"id": "r1", "riskEventType": "unfamiliarFeatures", "riskLevel": "medium"}, 2004, 2, 1},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw := entraRecordJSON(t, tc.category, tc.operationName, tc.properties)
			ev := MapEvent(goldenTenantID, Stream, raw, 1704067200)

			if ev.ClassUID != tc.wantClassUID || ev.CategoryUID != tc.wantCat || ev.ActivityID != tc.wantActy {
				t.Fatalf("got (class=%d, category=%d, activity=%d), want (class=%d, category=%d, activity=%d)",
					ev.ClassUID, ev.CategoryUID, ev.ActivityID, tc.wantClassUID, tc.wantCat, tc.wantActy)
			}
			if ev.SchemaVersion != SchemaVersion {
				t.Fatalf("SchemaVersion = %q, want %q", ev.SchemaVersion, SchemaVersion)
			}
			if ev.TimeUnixMillis != 1704067200000 {
				t.Fatalf("TimeUnixMillis = %d, want %d", ev.TimeUnixMillis, 1704067200000)
			}
		})
	}
}

// T2: "Deduplication against M365-sourced equivalents is correct" — the
// ticket's own literal AC. Proven by calling BOTH packages' MapEvent on
// records that share the SAME underlying Azure AD audit record id (the
// real-world situation AC5 describes: the same directory event, read
// through two different export paths) and asserting they produce the
// IDENTICAL EventID and Metadata — which is exactly what makes
// ClickHouse's ReplacingMergeTree collapse them into one stored row.
func TestMapEvent_DedupesAgainstM365Equivalents(t *testing.T) {
	const sharedRecordID = "shared-aad-record-guid-12345"

	t.Run("sign-in", func(t *testing.T) {
		azureRaw := entraRecordJSON(t, "SignInLogs", "Sign-in activity", map[string]any{"id": sharedRecordID, "userPrincipalName": "alice@contoso.com", "resultType": "0"})
		azureEv := MapEvent(goldenTenantID, Stream, azureRaw, 1704067200)

		m365Raw, err := json.Marshal(map[string]string{"Id": sharedRecordID, "CreationTime": "2024-01-01T00:00:00Z", "Operation": "UserLoggedIn", "UserId": "alice@contoso.com"})
		if err != nil {
			t.Fatalf("marshalling m365 record: %v", err)
		}
		m365Ev := m365.MapEvent(goldenTenantID, "Audit.AzureActiveDirectory", m365Raw, 1704067200)

		if azureEv.EventID != m365Ev.EventID {
			t.Fatalf("EventIDs must match for the same underlying record (dedup depends on this): azure=%q m365=%q", azureEv.EventID, m365Ev.EventID)
		}
		if azureEv.Metadata["product"] != m365Ev.Metadata["product"] || azureEv.Metadata["operation"] != m365Ev.Metadata["operation"] {
			t.Fatalf("Metadata must match so existing M365-keyed detection rules still match regardless of merge order: azure=%+v m365=%+v", azureEv.Metadata, m365Ev.Metadata)
		}
		if azureEv.ClassUID != m365Ev.ClassUID || azureEv.ActivityID != m365Ev.ActivityID {
			t.Fatalf("OCSF class/activity must match: azure=(%d,%d) m365=(%d,%d)", azureEv.ClassUID, azureEv.ActivityID, m365Ev.ClassUID, m365Ev.ActivityID)
		}
	})

	t.Run("add user", func(t *testing.T) {
		azureRaw := entraRecordJSON(t, "AuditLogs", "Add user", map[string]any{"id": sharedRecordID, "activityDisplayName": "Add user", "result": "success"})
		azureEv := MapEvent(goldenTenantID, Stream, azureRaw, 1704067200)

		m365Raw, err := json.Marshal(map[string]string{"Id": sharedRecordID, "CreationTime": "2024-01-01T00:00:00Z", "Operation": "Add user.", "UserId": "admin@contoso.com"})
		if err != nil {
			t.Fatalf("marshalling m365 record: %v", err)
		}
		m365Ev := m365.MapEvent(goldenTenantID, "Audit.AzureActiveDirectory", m365Raw, 1704067200)

		if azureEv.EventID != m365Ev.EventID {
			t.Fatalf("EventIDs must match: azure=%q m365=%q", azureEv.EventID, m365Ev.EventID)
		}
	})

	t.Run("different record ids never collide", func(t *testing.T) {
		raw1 := entraRecordJSON(t, "SignInLogs", "Sign-in activity", map[string]any{"id": "record-1", "resultType": "0"})
		raw2 := entraRecordJSON(t, "SignInLogs", "Sign-in activity", map[string]any{"id": "record-2", "resultType": "0"})
		ev1 := MapEvent(goldenTenantID, Stream, raw1, 1704067200)
		ev2 := MapEvent(goldenTenantID, Stream, raw2, 1704067200)
		if ev1.EventID == ev2.EventID {
			t.Fatal("two genuinely different records must not produce the same event_id")
		}
	})

	t.Run("risk detections never collide with M365 — nothing to deduplicate against", func(t *testing.T) {
		azureRaw := entraRecordJSON(t, "RiskDetections", "", map[string]any{"id": sharedRecordID, "riskEventType": "unfamiliarFeatures"})
		azureEv := MapEvent(goldenTenantID, Stream, azureRaw, 1704067200)
		if azureEv.Metadata["product"] != "azure" {
			t.Fatalf(`risk detections must keep their own distinct identity, got product=%q`, azureEv.Metadata["product"])
		}
	})
}

func TestMapEvent_UnknownAndUnparsableAreNeverDropped(t *testing.T) {
	t.Run("unrecognised audit activity", func(t *testing.T) {
		raw := entraRecordJSON(t, "AuditLogs", "Some future admin action", map[string]any{"id": "unknown-1", "activityDisplayName": "Some future admin action"})
		ev := MapEvent(goldenTenantID, Stream, raw, 1704067200)
		if ev.ClassUID != 0 {
			t.Fatalf("expected class_uid 0 for an unrecognised activity, got %d", ev.ClassUID)
		}
		if ev.Unmapped["activityDisplayName"] != "Some future admin action" {
			t.Fatalf("expected the unrecognised activity preserved under Unmapped, got %+v", ev.Unmapped)
		}
	})

	t.Run("unrecognised category", func(t *testing.T) {
		raw := entraRecordJSON(t, "SomeFutureCategory", "whatever", map[string]any{"id": "unknown-2"})
		ev := MapEvent(goldenTenantID, Stream, raw, 1704067200)
		if ev.ClassUID != 0 {
			t.Fatalf("expected class_uid 0 for an unrecognised category, got %d", ev.ClassUID)
		}
		if ev.EventID == "" {
			t.Fatal("expected a non-empty event_id even for an unrecognised category")
		}
	})

	t.Run("unparsable bytes", func(t *testing.T) {
		garbage := []byte(`{not json at all`)
		ev := MapEvent(goldenTenantID, Stream, garbage, 1704067200)
		if ev.ClassUID != 0 {
			t.Fatalf("expected class_uid 0 for unparsable input, got %d", ev.ClassUID)
		}
		if ev.EventID == "" {
			t.Fatal("expected a non-empty, deterministic event_id even for unparsable input")
		}
	})
}

func TestMapEvent_DeterministicAcrossRepeatedInvocations(t *testing.T) {
	raw := entraRecordJSON(t, "SignInLogs", "Sign-in activity", map[string]any{"id": "det-1", "resultType": "0"})

	var first string
	for i := 0; i < 200; i++ {
		ev := MapEvent(goldenTenantID, Stream, raw, int64(1700000000+i))
		if i == 0 {
			first = ev.EventID
			continue
		}
		if ev.EventID != first {
			t.Fatalf("invocation %d produced a different event_id (%q) than the first (%q)", i, ev.EventID, first)
		}
	}
}

func TestCoverageReport_CoversAllFamilies(t *testing.T) {
	report := CoverageReport()
	seenClassUIDs := map[int64]bool{}
	for _, entry := range report {
		seenClassUIDs[entry.ClassUID] = true
	}
	for _, want := range []int64{3002, 3001, 3006, 3005, 2004} {
		if !seenClassUIDs[want] {
			t.Fatalf("coverage report is missing class_uid %d", want)
		}
	}
}
