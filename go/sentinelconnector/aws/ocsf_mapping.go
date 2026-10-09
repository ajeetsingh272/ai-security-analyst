// P7-02: OCSF normalisation for AWS CloudTrail management events — the
// third connector, and the first push-based one built against a real
// vendor API rather than syslog's raw-socket precedent (see connector.go's
// own doc comment for why CloudTrail/SQS is architecturally much closer to
// M365/Google's own poll-shaped Fetch than to syslog's passive listener).
//
// Event names and class/category/activity_id values below were verified
// against AWS's own documented CloudTrail record format and the live OCSF
// 1.3.0 schema (schema.ocsf.io/1.3.0/classes/...) while writing this
// file, not recalled from memory — reviewers should re-verify rather than
// trusting this comment, same discipline go/sentinelconnector/m365 and
// go/sentinelconnector/google's own mapping files already establish.
package aws

import (
	"encoding/json"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/ocsf"
	"github.com/google/uuid"
)

const SchemaVersion = "aws-cloudtrail-ocsf-v1"

var eventIDNamespace = uuid.MustParse("1f0e9c7a-3d5b-4e8a-9c1d-7a2b4e6f8c0a")

type activityMapping struct {
	ClassUID    int64
	CategoryUID int64
	ActivityID  int64
}

// activityMappings is keyed by CloudTrail's own eventName — unlike
// Google's composite applicationName/eventName key, CloudTrail eventNames
// are already globally distinct across AWS services (confirmed against
// AWS's own documented event reference), so a flat map matches M365's own
// single-namespace convention.
//
// Mirrors M365/Google's own family convention one for one:
//   - sign-in:  ConsoleLogin -> Authentication (3002, category 3).
//   - admin:    CreateUser/DeleteUser (IAM) -> Account Change (3001,
//     category 3), the direct AWS analogue of M365's "Add user."/
//     "Delete user." and Google's CREATE_USER/DELETE_USER.
//   - access-grant: AssumeRole, AttachUserPolicy, CreateAccessKey ->
//     User Access Management (3005, category 3) — granting a principal
//     new access, the same class M365's "Consent to application." and
//     Google's token/authorize use. DetachUserPolicy/DeleteAccessKey are
//     the Revoke-Privileges counterpart.
//   - resource-policy: PutBucketPolicy/PutBucketAcl -> API Activity
//     (6003, category 6) — OCSF's own class, whose documentation names
//     "AWS CloudTrail" explicitly as its worked example for "general CRUD
//     API activities" that don't have a more specific OCSF home. This is
//     a deliberate, disclosed choice: an S3 bucket-policy change is a
//     resource-level permission edit, not a file transfer (File Hosting
//     Activity, 6006, would be a forced fit) and not a change to an
//     IAM principal's own access (User Access Management, 3005, models
//     privilege assignment, not resource-policy edits) — API Activity is
//     the honest "general AWS API call" home OCSF itself names for
//     exactly this kind of event.
var activityMappings = map[string]activityMapping{
	"ConsoleLogin": {ClassUID: 3002, CategoryUID: 3, ActivityID: 1}, // Logon

	"CreateUser": {ClassUID: 3001, CategoryUID: 3, ActivityID: 1}, // Create
	"DeleteUser": {ClassUID: 3001, CategoryUID: 3, ActivityID: 6}, // Delete

	"AssumeRole":       {ClassUID: 3005, CategoryUID: 3, ActivityID: 1}, // Assign Privileges
	"AttachUserPolicy": {ClassUID: 3005, CategoryUID: 3, ActivityID: 1}, // Assign Privileges
	"CreateAccessKey":  {ClassUID: 3005, CategoryUID: 3, ActivityID: 1}, // Assign Privileges — a new long-lived credential IS an access grant
	"DetachUserPolicy": {ClassUID: 3005, CategoryUID: 3, ActivityID: 2}, // Revoke Privileges
	"DeleteAccessKey":  {ClassUID: 3005, CategoryUID: 3, ActivityID: 2}, // Revoke Privileges

	"PutBucketPolicy": {ClassUID: 6003, CategoryUID: 6, ActivityID: 3}, // Update
	"PutBucketAcl":    {ClassUID: 6003, CategoryUID: 6, ActivityID: 3}, // Update
}

type CoverageEntry struct {
	EventName   string
	ClassUID    int64
	CategoryUID int64
	ActivityID  int64
}

func CoverageReport() []CoverageEntry {
	out := make([]CoverageEntry, 0, len(activityMappings))
	for name, m := range activityMappings {
		out = append(out, CoverageEntry{EventName: name, ClassUID: m.ClassUID, CategoryUID: m.CategoryUID, ActivityID: m.ActivityID})
	}
	return out
}

// cloudTrailRecord is the subset of a CloudTrail record's fields this
// mapping actually reads — https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-event-reference-record-contents.html.
// Every other field the real event carries is preserved under Unmapped
// regardless (MapEvent's own unmappedFields), mirroring m365Record/
// activityItem's identical "read a few typed fields, preserve the rest"
// shape.
type cloudTrailRecord struct {
	EventID         string `json:"eventID"`
	EventTime       string `json:"eventTime"` // ISO8601, e.g. "2026-01-01T00:00:00Z"
	EventName       string `json:"eventName"`
	EventSource     string `json:"eventSource"`
	SourceIPAddress string `json:"sourceIPAddress"`
	AWSRegion       string `json:"awsRegion"`
	UserIdentity    struct {
		Type        string `json:"type"`
		ARN         string `json:"arn"`
		AccountID   string `json:"accountId"`
		UserName    string `json:"userName"`
		PrincipalID string `json:"principalId"`
	} `json:"userIdentity"`
	ErrorCode string `json:"errorCode"`
}

// MapEvent is this package's version of m365.MapEvent/google.MapEvent —
// pure, total, deterministic, no I/O/clock/injected client. stream is
// always "cloudtrail" (AWS has only the one event stream this connector
// reads, unlike M365's four content types or Google's five application
// names), kept as a parameter for signature symmetry with the other two
// connectors' Normalise methods and because RawEvent carries no
// start-up-time context of its own.
func MapEvent(tenantID, stream string, raw []byte, fetchedAtUnix int64) ocsf.Event {
	var rec cloudTrailRecord
	parsed := json.Unmarshal(raw, &rec) == nil

	timeMillis, offset := fetchedAtUnix*1000, "Z"
	if parsed && rec.EventTime != "" {
		if ms, off, ok := parseCloudTrailTimestamp(rec.EventTime); ok {
			timeMillis, offset = ms, off
		}
	}

	ev := ocsf.Event{
		EventID:        eventID(tenantID, stream, rec.EventID, raw),
		SchemaVersion:  SchemaVersion,
		TimeUnixMillis: timeMillis,
		TimeOffset:     offset,
		TenantID:       tenantID,
		// "product" is dispatch's one always-present candidate-selection
		// dimension (see m365/google's identical comment) — "aws", not
		// "aws_cloudtrail", matching the connectors.kind value and
		// overview.md §3.1's own "AWS" row naming.
		Metadata: map[string]string{"source": "aws", "content_type": stream, "product": "aws", "operation": rec.EventName},
		RawData:  raw,
	}

	mapping, ok := activityMappings[rec.EventName]
	if !parsed || !ok {
		ev.ClassUID, ev.CategoryUID, ev.ActivityID, ev.TypeUID = 0, 0, 0, 0
		ev.Unmapped = unmappedFields(raw, parsed, false)
		return ev
	}

	ev.ClassUID, ev.CategoryUID, ev.ActivityID = mapping.ClassUID, mapping.CategoryUID, mapping.ActivityID
	ev.TypeUID = mapping.ClassUID*100 + mapping.ActivityID
	ev.Unmapped = unmappedFields(raw, parsed, true)
	return ev
}

// unmappedFields mirrors m365's own unmappedFields exactly — every
// top-level field this struct didn't read by name is preserved verbatim
// (stringified), never discarded; eventMapped controls whether eventName
// itself is excluded once it's already represented structurally.
func unmappedFields(raw []byte, parsed, eventMapped bool) map[string]string {
	if !parsed {
		return map[string]string{"_raw": string(raw)}
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(raw, &all); err != nil {
		return map[string]string{"_raw": string(raw)}
	}
	out := make(map[string]string, len(all))
	for k, v := range all {
		if k == "eventID" || k == "eventTime" {
			continue
		}
		if k == "eventName" && eventMapped {
			continue
		}
		s := string(v)
		if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
			var unquoted string
			if err := json.Unmarshal(v, &unquoted); err == nil {
				s = unquoted
			}
		}
		out[k] = s
	}
	return out
}

// parseCloudTrailTimestamp accepts CloudTrail's own documented eventTime
// format (RFC3339/ISO8601, always UTC — "AWS CloudTrail always uses UTC
// for eventTime"), falling back to false (never an error) for anything
// else, keeping MapEvent total.
func parseCloudTrailTimestamp(s string) (unixMillis int64, offset string, ok bool) {
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.UTC().UnixMilli(), "Z", true
	}
	return 0, "", false
}

// eventID mirrors m365/google's own eventID — UUIDv5, deterministic,
// keyed on CloudTrail's own globally-unique eventID field (AWS generates
// one per record already, unlike M365's content-blob id or Google's
// uniqueQualifier, so there is no "no vendor id" fallback case in
// practice — the hash-the-raw-payload fallback is kept anyway, same total-
// function discipline, for the pathological case of a record missing it).
func eventID(tenantID, stream, cloudTrailEventID string, raw []byte) string {
	name := tenantID + "|aws|" + stream + "|" + cloudTrailEventID
	if cloudTrailEventID == "" {
		name = tenantID + "|aws|" + stream + "|" + string(raw)
	}
	return "evt_" + uuid.NewSHA1(eventIDNamespace, []byte(name)).String()
}
