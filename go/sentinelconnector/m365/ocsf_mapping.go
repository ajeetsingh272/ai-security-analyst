// P1-04: OCSF normalisation for M365 event families (ADR-0002, SECURITY.md's
// TG1 trust guarantee — "AI output is never unsourced"). Everything in this
// file is a pure, total function: no I/O, no clock, no network, and no
// injected client of any kind — MapEvent cannot reach outside its own
// arguments even by accident, which is the literal mechanism AC1 asks
// review to enforce ("the absence of injected clients").
//
// Class/category/activity_id values below were verified against the live
// OCSF 1.3.0 schema (schema.ocsf.io/1.3.0/classes/...) while writing this
// file, not recalled from memory — this is a two-reviewer-gated ticket and
// a wrong class_uid here is exactly the kind of error that discipline
// exists to catch, so reviewers should re-verify them against the same
// source rather than trusting this comment.
package m365

import (
	"encoding/json"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/ocsf"
	"github.com/google/uuid"
)

// SchemaVersion is stamped on every event this package produces (ADR-0002:
// "mappings are versioned and additive; old events keep their original
// version"). Bump this, and only this, when the mapping table below
// changes in a way that affects already-stored events' meaning — never
// retroactively rewrite an already-stored event's schema_version.
const SchemaVersion = "m365-ocsf-v1"

// eventIDNamespace is a fixed, arbitrary UUID — any constant works, what
// matters is that it NEVER changes once real events exist, since changing
// it would silently change every future event_id for data that already
// has grounded claims pointing at the OLD id (SECURITY.md TG1). Generated
// once via `uuidgen` and hardcoded; there is no mechanism (and no reason)
// to regenerate it.
var eventIDNamespace = uuid.MustParse("5c1e5f1a-7f3b-4c2a-9c3d-6f0a1b2c3d4e")

// operationMapping is one row of the table below: an M365 audit record's
// "Operation" field maps to exactly one OCSF class/category/activity.
type operationMapping struct {
	ClassUID    int64
	CategoryUID int64
	ActivityID  int64
}

// operationMappings is the mapping coverage report's own source of truth
// (AC: "a mapping coverage report lists which M365 operations are mapped
// and which are not") — CoverageReport below returns exactly these keys.
// Every M365 Operation value NOT in this table still produces a valid
// event (AC1's "pure, total"): ClassUID 0 ("uncategorized", the same
// escape hatch P1-03 used for everything before this ticket existed),
// with the original Operation preserved under Unmapped rather than
// discarded (AC2).
//
// Covers ADR-0002's five named M365 event families:
//   - sign-in:    Authentication (3002, category 3)
//   - mailbox:    Email Activity (4009, category 4)
//   - file:       File Hosting Activity (6006, category 6)
//   - admin:      Account Change (3001) and Group Management (3006), both category 3
//   - consent:    User Access Management (3005, category 3)
var operationMappings = map[string]operationMapping{
	// Sign-in activity (Audit.AzureActiveDirectory) — Authentication (3002).
	// activity_id 1 (Logon) regardless of success/failure: OCSF models
	// success/failure on a separate status_id field this ticket's Event
	// struct does not yet carry, not on activity_id itself.
	"UserLoggedIn": {ClassUID: 3002, CategoryUID: 3, ActivityID: 1},

	// Mailbox activity (Audit.Exchange) — Email Activity (4009).
	"Send":              {ClassUID: 4009, CategoryUID: 4, ActivityID: 1}, // Send
	"SendAs":            {ClassUID: 4009, CategoryUID: 4, ActivityID: 1},
	"SendOnBehalf":      {ClassUID: 4009, CategoryUID: 4, ActivityID: 1},
	"MailItemsAccessed": {ClassUID: 4009, CategoryUID: 4, ActivityID: 99}, // no Read/Access value in this enum — Other, honestly, not a forced fit

	// File activity (Audit.SharePoint) — File Hosting Activity (6006).
	"FileUploaded":             {ClassUID: 6006, CategoryUID: 6, ActivityID: 1},  // Upload
	"FileDownloaded":           {ClassUID: 6006, CategoryUID: 6, ActivityID: 2},  // Download
	"FileModified":             {ClassUID: 6006, CategoryUID: 6, ActivityID: 3},  // Update
	"FileDeleted":              {ClassUID: 6006, CategoryUID: 6, ActivityID: 4},  // Delete
	"FileRenamed":              {ClassUID: 6006, CategoryUID: 6, ActivityID: 5},  // Rename
	"FileCopied":               {ClassUID: 6006, CategoryUID: 6, ActivityID: 6},  // Copy
	"FileMoved":                {ClassUID: 6006, CategoryUID: 6, ActivityID: 7},  // Move
	"FileAccessed":             {ClassUID: 6006, CategoryUID: 6, ActivityID: 14}, // Open
	"SharingSet":               {ClassUID: 6006, CategoryUID: 6, ActivityID: 12}, // Share
	"AnonymousLinkCreated":     {ClassUID: 6006, CategoryUID: 6, ActivityID: 12}, // Share
	"SharingInvitationCreated": {ClassUID: 6006, CategoryUID: 6, ActivityID: 12}, // Share
	"AnonymousLinkRemoved":     {ClassUID: 6006, CategoryUID: 6, ActivityID: 13}, // Unshare

	// Admin activity (Audit.AzureActiveDirectory / Audit.General) — Account
	// Change (3001) for the account entity's own state, Group Management
	// (3006) for group membership — both category 3.
	"Add user.":                 {ClassUID: 3001, CategoryUID: 3, ActivityID: 1}, // Create
	"Delete user.":              {ClassUID: 3001, CategoryUID: 3, ActivityID: 6}, // Delete
	"Change user password.":     {ClassUID: 3001, CategoryUID: 3, ActivityID: 3}, // Password Change
	"Reset user password.":      {ClassUID: 3001, CategoryUID: 3, ActivityID: 4}, // Password Reset
	"Disable account.":          {ClassUID: 3001, CategoryUID: 3, ActivityID: 5}, // Disable
	"Add member to group.":      {ClassUID: 3006, CategoryUID: 3, ActivityID: 3}, // Add User
	"Remove member from group.": {ClassUID: 3006, CategoryUID: 3, ActivityID: 4}, // Remove User
	"Add group.":                {ClassUID: 3006, CategoryUID: 3, ActivityID: 6}, // Create
	"Delete group.":             {ClassUID: 3006, CategoryUID: 3, ActivityID: 5}, // Delete

	// Consent activity (Audit.AzureActiveDirectory) — User Access
	// Management (3005, category 3): granting/revoking an application's
	// access is exactly what this class models ("management updates to a
	// user's privileges").
	"Consent to application.":       {ClassUID: 3005, CategoryUID: 3, ActivityID: 1}, // Assign Privileges
	"Remove OAuth2PermissionGrant.": {ClassUID: 3005, CategoryUID: 3, ActivityID: 2}, // Revoke Privileges
}

// CoverageReport is AC's own required deliverable: "a mapping coverage
// report lists which M365 operations are mapped and which are not."
// Everything returned here IS mapped, to the class/category/activity shown
// — any M365 Operation value not in this list is NOT mapped, and produces
// an event with ClassUID 0 and the original Operation preserved under
// Unmapped (see MapEvent).
type CoverageEntry struct {
	Operation   string
	ClassUID    int64
	CategoryUID int64
	ActivityID  int64
}

func CoverageReport() []CoverageEntry {
	out := make([]CoverageEntry, 0, len(operationMappings))
	for op, m := range operationMappings {
		out = append(out, CoverageEntry{Operation: op, ClassUID: m.ClassUID, CategoryUID: m.CategoryUID, ActivityID: m.ActivityID})
	}
	return out
}

// m365Record is the subset of an M365 unified audit log record's fields
// this mapping actually reads. Every other field in the real payload is
// preserved verbatim in RawData regardless (and, for a JSON object we can
// at least partially parse, under Unmapped too — see MapEvent).
type m365Record struct {
	ID           string `json:"Id"`
	CreationTime string `json:"CreationTime"`
	Operation    string `json:"Operation"`
}

// MapEvent is P1-04's actual deliverable: a pure, total function
// (AC1) from one raw M365 audit record to one OCSF event. "Total" means
// exactly that — there is no input, however malformed, that makes this
// function error or panic; the worst case is an event with ClassUID 0,
// TimeUnixMillis falling back to fetchedAtUnix, and the entire raw payload
// under Unmapped["_raw"], which is still a valid, groundable event (T2).
// Exported (not just Connector.Normalise's private implementation) because
// T6's own scenario — re-normalising the same raw payload after a replay —
// is exactly the shape a future replay tool would call directly, and
// because this ticket's own integration tests (T5/T6, services/ingest)
// need it without standing up a full Connector against a mock HTTP server
// just to reach a pure function.
func MapEvent(tenantID, contentType string, raw []byte, fetchedAtUnix int64) ocsf.Event {
	var rec m365Record
	parsed := json.Unmarshal(raw, &rec) == nil

	timeMillis, offset := fetchedAtUnix*1000, "Z"
	if parsed && rec.CreationTime != "" {
		if ms, off, ok := parseM365Timestamp(rec.CreationTime); ok {
			timeMillis, offset = ms, off
		}
	}

	ev := ocsf.Event{
		EventID:        eventID(tenantID, contentType, rec.ID, raw),
		SchemaVersion:  SchemaVersion,
		TimeUnixMillis: timeMillis,
		TimeOffset:     offset,
		TenantID:       tenantID,
		// "product" is read directly by services/detect/internal/dispatch
		// as its one always-available dispatch dimension (every Sigma rule
		// declares logsource.product unconditionally) — without it here, no
		// M365 event would ever carry the one field the detection engine
		// uses to find candidate rules at all.
		Metadata: map[string]string{"source": "m365", "content_type": contentType, "product": "m365"},
		RawData:  raw,
	}

	mapping, ok := operationMappings[rec.Operation]
	if !parsed || !ok {
		ev.ClassUID, ev.CategoryUID, ev.ActivityID = 0, 0, 0
		// AC2/T2: the Operation value itself is NOT excluded here, unlike
		// the mapped branch below — nothing else in this event structurally
		// records what the unrecognised operation actually was, so leaving
		// it in Unmapped is the only thing standing between "unknown" and
		// "silently lost."
		ev.Unmapped = unmappedFields(raw, parsed, false)
		ev.TypeUID = 0
		return ev
	}

	ev.ClassUID, ev.CategoryUID, ev.ActivityID = mapping.ClassUID, mapping.CategoryUID, mapping.ActivityID
	ev.TypeUID = mapping.ClassUID*100 + mapping.ActivityID
	ev.Unmapped = unmappedFields(raw, parsed, true)
	return ev
}

// unmappedFields is AC2: "unmapped vendor fields are preserved under
// unmapped rather than discarded." m365Record only reads Id/CreationTime/
// Operation — every OTHER top-level field the vendor sent (UserId,
// Workload, ClientIP, whatever M365 adds next year without this package
// knowing about it) lands here, stringified to match
// db/clickhouse/0001_events.sql's `unmapped Map(String,String)` column. A
// payload this function couldn't even parse as a JSON object still
// produces an entry — the raw bytes, under "_raw" — rather than an empty
// map that would silently look like "nothing was unmapped." operationMapped
// controls whether "Operation" itself is excluded (see the two call sites'
// own comments for why that differs between the mapped and unmapped cases).
func unmappedFields(raw []byte, parsed, operationMapped bool) map[string]string {
	if !parsed {
		return map[string]string{"_raw": string(raw)}
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(raw, &all); err != nil {
		return map[string]string{"_raw": string(raw)}
	}
	out := make(map[string]string, len(all))
	for k, v := range all {
		if k == "Id" || k == "CreationTime" {
			continue
		}
		if k == "Operation" && operationMapped {
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

// parseM365Timestamp accepts RFC3339 with any offset (what this ticket's
// own tests exercise for T4 — non-UTC offsets, DST boundaries) as well as
// the no-offset form Microsoft's real CreationTime field actually uses in
// production ("2020-01-01T12:00:00", implicitly UTC) — returning false
// rather than an error for anything else, since MapEvent must stay
// total regardless.
func parseM365Timestamp(s string) (unixMillis int64, offset string, ok bool) {
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.UTC().UnixMilli(), formatOffset(t), true
	}
	if t, err := time.Parse("2006-01-02T15:04:05", s); err == nil {
		return t.UTC().UnixMilli(), "Z", true
	}
	return 0, "", false
}

func formatOffset(t time.Time) string {
	_, offsetSeconds := t.Zone()
	if offsetSeconds == 0 {
		return "Z"
	}
	sign := "+"
	if offsetSeconds < 0 {
		sign = "-"
		offsetSeconds = -offsetSeconds
	}
	hours := offsetSeconds / 3600
	minutes := (offsetSeconds % 3600) / 60
	return sign + pad2(hours) + ":" + pad2(minutes)
}

func pad2(n int) string {
	if n < 10 {
		return "0" + itoa1(n)
	}
	return itoa1(n)
}

func itoa1(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [4]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

// eventID is AC4: deterministic from the source event, stable across
// re-normalisation (T3/T6) — UUIDv5 (SHA-1, RFC 4122), never a random
// UUID or a ULID, because both of those would make this function neither
// deterministic nor total. Keyed on the vendor's own record Id when
// present; falling back to hashing the entire raw payload when it is not
// (still deterministic, still total — AC1).
func eventID(tenantID, contentType, vendorID string, raw []byte) string {
	name := tenantID + "|m365|" + contentType + "|" + vendorID
	if vendorID == "" {
		name = tenantID + "|m365|" + contentType + "|" + string(raw)
	}
	return "evt_" + uuid.NewSHA1(eventIDNamespace, []byte(name)).String()
}
