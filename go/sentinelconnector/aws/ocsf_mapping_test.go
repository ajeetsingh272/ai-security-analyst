package aws

import (
	"encoding/json"
	"testing"
)

const goldenTenantID = "66666666-6666-4666-8666-666666666666"

func cloudTrailJSON(t *testing.T, eventID, eventTime, eventName, userName string) []byte {
	t.Helper()
	rec := map[string]any{
		"eventID":         eventID,
		"eventTime":       eventTime,
		"eventName":       eventName,
		"eventSource":     "iam.amazonaws.com",
		"sourceIPAddress": "203.0.113.5",
		"awsRegion":       "ap-south-1",
		"userIdentity":    map[string]any{"type": "IAMUser", "userName": userName},
	}
	b, err := json.Marshal(rec)
	if err != nil {
		t.Fatalf("marshalling fixture: %v", err)
	}
	return b
}

// T3: "CloudTrail normalisation matches golden fixtures" — one per
// family, mirroring m365/google's own golden-fixture test shape.
func TestMapEvent_GoldenFixturesPerFamily(t *testing.T) {
	cases := []struct {
		name                            string
		eventName                       string
		wantClassUID, wantCat, wantActy int64
	}{
		{"sign-in", "ConsoleLogin", 3002, 3, 1},
		{"create user", "CreateUser", 3001, 3, 1},
		{"delete user", "DeleteUser", 3001, 3, 6},
		{"assume role", "AssumeRole", 3005, 3, 1},
		{"attach user policy", "AttachUserPolicy", 3005, 3, 1},
		{"detach user policy", "DetachUserPolicy", 3005, 3, 2},
		{"put bucket policy", "PutBucketPolicy", 6003, 6, 3},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw := cloudTrailJSON(t, "evt-"+tc.name, "2024-01-01T00:00:00Z", tc.eventName, "alice")
			ev := MapEvent(goldenTenantID, Stream, raw, 1704067200)

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
			if ev.Metadata["product"] != "aws" {
				t.Fatalf(`Metadata["product"] = %q, want "aws"`, ev.Metadata["product"])
			}
			if ev.Metadata["operation"] != tc.eventName {
				t.Fatalf(`Metadata["operation"] = %q, want %q`, ev.Metadata["operation"], tc.eventName)
			}
			if ev.TimeUnixMillis != 1704067200000 {
				t.Fatalf("TimeUnixMillis = %d, want %d", ev.TimeUnixMillis, 1704067200000)
			}
			if ev.Unmapped["sourceIPAddress"] != "203.0.113.5" {
				t.Fatalf("expected sourceIPAddress preserved under Unmapped, got %+v", ev.Unmapped)
			}
			if _, leaked := ev.Unmapped["eventName"]; leaked {
				t.Fatalf("eventName should NOT appear in Unmapped once mapped, got %+v", ev.Unmapped)
			}
		})
	}
}

// AC1's "pure, total" taken to its limit: an unrecognised eventName and
// unparsable bytes must both still produce a valid event.
func TestMapEvent_UnknownAndUnparsableAreNeverDropped(t *testing.T) {
	t.Run("unrecognised event name", func(t *testing.T) {
		raw := cloudTrailJSON(t, "evt-unknown", "2024-01-01T00:00:00Z", "SomeFutureAPICallNobodyMappedYet", "eve")
		ev := MapEvent(goldenTenantID, Stream, raw, 1704067200)
		if ev.ClassUID != 0 {
			t.Fatalf("expected class_uid 0 for an unrecognised event, got %d", ev.ClassUID)
		}
		if ev.Unmapped["eventName"] != "SomeFutureAPICallNobodyMappedYet" {
			t.Fatalf("expected the unrecognised eventName preserved under Unmapped, got %+v", ev.Unmapped)
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
		if ev.Unmapped["_raw"] != string(garbage) {
			t.Fatalf("expected raw bytes preserved under Unmapped[_raw], got %+v", ev.Unmapped)
		}
	})
}

func TestMapEvent_DeterministicAcrossRepeatedInvocations(t *testing.T) {
	raw := cloudTrailJSON(t, "evt-det-1", "2024-06-15T10:30:00Z", "AssumeRole", "frank")

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
	for _, want := range []int64{3002, 3001, 3005, 6003} {
		if !seenClassUIDs[want] {
			t.Fatalf("coverage report is missing class_uid %d", want)
		}
	}
}
