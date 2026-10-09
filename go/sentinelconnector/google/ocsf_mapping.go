// P7-01: OCSF normalisation for Google Workspace Admin SDK Reports API
// activities — the second identity-platform connector, built to prove the
// connector-developer-guide's abstraction holds for a source that isn't
// M365. Same discipline as go/sentinelconnector/m365/ocsf_mapping.go: a
// pure, total function, no I/O, no clock, no injected client.
//
// Event names mapped below were verified against Google's own published
// Admin SDK Reports API reference (developers.google.com/admin-sdk/reports/v1/appendix/activity/{login,drive,admin-user-settings,admin-group-settings,token,gmail})
// while writing this file, not recalled from memory — reviewers should
// re-verify against the same source rather than trusting this comment.
// Class/category/activity_id values mirror the already-reviewed M365
// mapping (go/sentinelconnector/m365/ocsf_mapping.go) wherever the
// underlying technique is the same, which is exactly what T2 checks.
package google

import (
	"encoding/json"
	"strconv"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/ocsf"
	"github.com/google/uuid"
)

// SchemaVersion is stamped on every event this package produces — ADR-0002's
// "mappings are versioned and additive." Bump only when the mapping table
// below changes in a way that affects already-stored events' meaning.
const SchemaVersion = "google-workspace-ocsf-v1"

// eventIDNamespace is a fixed, arbitrary UUID, generated once via `uuidgen`
// and hardcoded — never regenerate it once real events exist (see m365's
// identical doc comment on why).
var eventIDNamespace = uuid.MustParse("8a2b6e3d-4f1c-4a9e-9d5b-1c7f2e6a3b9d")

// activityMapping is one row of activityMappings below.
type activityMapping struct {
	ClassUID    int64
	CategoryUID int64
	ActivityID  int64
}

// activityMappings is keyed by "<applicationName>/<eventName>" — Google's
// own Reports API partitions events by applicationName (login, admin,
// drive, token, ...) and eventName is only unique WITHIN one
// applicationName, unlike M365's single flat Operation namespace, so the
// composite key is this package's own equivalent of M365's operationMappings
// map.
//
// Deliberately mirrors M365's own five families (ADR-0002) one for one:
//   - sign-in:  login/login_success, login/login_failure, login/suspicious_login
//     all -> Authentication (3002, category 3) — login/login_success is
//     T2's own equivalence target: it MUST match m365's "UserLoggedIn" row
//     (3002, 3, 1) exactly.
//   - admin:    admin/CREATE_USER, DELETE_USER, SUSPEND_USER, CHANGE_PASSWORD
//     -> Account Change (3001, category 3), mirroring M365's "Add user."/
//     "Delete user."/"Disable account."/"Change user password." rows.
//   - group:    admin/ADD_GROUP_MEMBER, REMOVE_GROUP_MEMBER, CREATE_GROUP,
//     DELETE_GROUP -> Group Management (3006, category 3), mirroring M365's
//     own group rows exactly.
//   - file:     drive/view, download, edit, create, delete, trash, rename,
//     copy, move, change_document_access_scope, shared_externally,
//     shared_internally -> File Hosting Activity (6006, category 6),
//     mirroring M365's FileAccessed/FileDownloaded/.../SharingSet rows.
//   - consent:  token/authorize, token/revoke -> User Access Management
//     (3005, category 3), mirroring M365's "Consent to application."/
//     "Remove OAuth2PermissionGrant." rows.
//
// Gmail is handled separately (see gmailEventTypeMappings below): Gmail
// audit events all share the one literal eventName "delivery"
// (developers.google.com/admin-sdk/reports/v1/appendix/activity/gmail),
// with the actual activity distinguished by the event's own
// "mail_event_type" parameter, not by eventName.
var activityMappings = map[string]activityMapping{
	"login/login_success":    {ClassUID: 3002, CategoryUID: 3, ActivityID: 1}, // Logon
	"login/login_failure":    {ClassUID: 3002, CategoryUID: 3, ActivityID: 1}, // same note as m365's UserLoggedIn: success/failure isn't modelled on activity_id in this minimal Event struct
	"login/suspicious_login": {ClassUID: 3002, CategoryUID: 3, ActivityID: 1},
	"login/logout":           {ClassUID: 3002, CategoryUID: 3, ActivityID: 2}, // Logoff

	"admin/CREATE_USER":     {ClassUID: 3001, CategoryUID: 3, ActivityID: 1}, // Create
	"admin/DELETE_USER":     {ClassUID: 3001, CategoryUID: 3, ActivityID: 6}, // Delete
	"admin/SUSPEND_USER":    {ClassUID: 3001, CategoryUID: 3, ActivityID: 5}, // Disable
	"admin/CHANGE_PASSWORD": {ClassUID: 3001, CategoryUID: 3, ActivityID: 3}, // Password Change

	"admin/ADD_GROUP_MEMBER":    {ClassUID: 3006, CategoryUID: 3, ActivityID: 3}, // Add User
	"admin/REMOVE_GROUP_MEMBER": {ClassUID: 3006, CategoryUID: 3, ActivityID: 4}, // Remove User
	"admin/CREATE_GROUP":        {ClassUID: 3006, CategoryUID: 3, ActivityID: 6}, // Create
	"admin/DELETE_GROUP":        {ClassUID: 3006, CategoryUID: 3, ActivityID: 5}, // Delete

	"drive/view":     {ClassUID: 6006, CategoryUID: 6, ActivityID: 14}, // Open
	"drive/download": {ClassUID: 6006, CategoryUID: 6, ActivityID: 2},  // Download
	"drive/edit":     {ClassUID: 6006, CategoryUID: 6, ActivityID: 3},  // Update
	"drive/create":   {ClassUID: 6006, CategoryUID: 6, ActivityID: 1},  // Upload — closest honest analogue for "new content stored," same activity_id m365 uses for FileUploaded
	"drive/delete":   {ClassUID: 6006, CategoryUID: 6, ActivityID: 4},  // Delete
	"drive/trash":    {ClassUID: 6006, CategoryUID: 6, ActivityID: 4},  // Delete — Drive's soft-delete; OCSF has no separate "trash" activity, disclosed here rather than silently conflated elsewhere
	"drive/rename":   {ClassUID: 6006, CategoryUID: 6, ActivityID: 5},  // Rename
	"drive/copy":     {ClassUID: 6006, CategoryUID: 6, ActivityID: 6},  // Copy
	"drive/move":     {ClassUID: 6006, CategoryUID: 6, ActivityID: 7},  // Move

	"drive/change_document_access_scope": {ClassUID: 6006, CategoryUID: 6, ActivityID: 12}, // Share
	"drive/shared_externally":            {ClassUID: 6006, CategoryUID: 6, ActivityID: 12}, // Share
	"drive/shared_internally":            {ClassUID: 6006, CategoryUID: 6, ActivityID: 12}, // Share

	"token/authorize": {ClassUID: 3005, CategoryUID: 3, ActivityID: 1}, // Assign Privileges
	"token/revoke":    {ClassUID: 3005, CategoryUID: 3, ActivityID: 2}, // Revoke Privileges
}

// gmailEventTypeMappings maps the "mail_event_type" parameter's integer
// value (developers.google.com/admin-sdk/reports/v1/appendix/activity/gmail)
// to an Email Activity (4009, category 4) OCSF event — mirroring M365's own
// mailbox family exactly, including its "no Read/Access value in this enum"
// honesty: only Send (activity_id 1) has a clean OCSF home, everything else
// this package can respect falls to Other (99), same as m365's
// MailItemsAccessed. Every mail_event_type value NOT in this table (bounce,
// quarantine, label changes, ...) is intentionally left unmapped (class_uid
// 0) rather than guessed — never a forced fit.
var gmailEventTypeMappings = map[int64]activityMapping{
	1:  {ClassUID: 4009, CategoryUID: 4, ActivityID: 1},  // Message sent -> Send
	35: {ClassUID: 4009, CategoryUID: 4, ActivityID: 1},  // Email send process initiated -> Send
	2:  {ClassUID: 4009, CategoryUID: 4, ActivityID: 99}, // Message received -> Other
	7:  {ClassUID: 4009, CategoryUID: 4, ActivityID: 99}, // Message opened for the first time -> Other
	31: {ClassUID: 4009, CategoryUID: 4, ActivityID: 99}, // Message viewed -> Other
}

// CoverageEntry/CoverageReport mirror m365's own deliverable: "a mapping
// coverage report lists which operations are mapped and which are not."
type CoverageEntry struct {
	Key         string // "<applicationName>/<eventName>", or "gmail/mail_event_type=<n>"
	ClassUID    int64
	CategoryUID int64
	ActivityID  int64
}

func CoverageReport() []CoverageEntry {
	out := make([]CoverageEntry, 0, len(activityMappings)+len(gmailEventTypeMappings))
	for k, m := range activityMappings {
		out = append(out, CoverageEntry{Key: k, ClassUID: m.ClassUID, CategoryUID: m.CategoryUID, ActivityID: m.ActivityID})
	}
	for n, m := range gmailEventTypeMappings {
		out = append(out, CoverageEntry{Key: "gmail/mail_event_type=" + strconv.FormatInt(n, 10), ClassUID: m.ClassUID, CategoryUID: m.CategoryUID, ActivityID: m.ActivityID})
	}
	return out
}

// eventParameter is one entry from a Reports API event's "parameters" array
// (developers.google.com/admin-sdk/reports/v1/reference/activities/list) —
// Google returns exactly one of these three value fields populated per
// parameter, never more than one.
type eventParameter struct {
	Name      string `json:"name"`
	Value     string `json:"value"`
	IntValue  string `json:"intValue"` // Google wire-encodes int64 parameter values as a JSON string
	BoolValue *bool  `json:"boolValue"`
}

type activityEvent struct {
	Type       string           `json:"type"`
	Name       string           `json:"name"`
	Parameters []eventParameter `json:"parameters"`
}

type activityItem struct {
	ID struct {
		Time            string `json:"time"` // RFC3339 with milliseconds, e.g. "2024-01-01T00:00:00.000Z"
		UniqueQualifier string `json:"uniqueQualifier"`
		ApplicationName string `json:"applicationName"`
	} `json:"id"`
	Actor struct {
		Email string `json:"email"`
	} `json:"actor"`
	IPAddress string          `json:"ipAddress"`
	Events    []activityEvent `json:"events"`
}

// rawEventRecord is this package's own one-event-per-record wire format —
// content.go's Fetch constructs one of these per (item, event index) pair,
// exactly as m365's Fetch unmarshals one content blob into individual
// records. Item holds the ENTIRE original Google API item verbatim
// (json.RawMessage, byte for byte) so RawData below always preserves real
// vendor truth even though Google's own wire shape nests multiple events
// inside one item — there is no smaller atomic unit in Google's own API to
// point RawData at instead.
type rawEventRecord struct {
	Item       json.RawMessage `json:"item"`
	EventIndex int             `json:"eventIndex"`
}

// MapEvent is this package's version of m365.MapEvent — pure, total,
// deterministic. tenantID/stream/fetchedAtUnix/raw have the identical
// meaning Connector.Normalise passes along; stream is the applicationName
// this connector instance was registered for (login/admin/drive/token/
// gmail), matching m365's contentType parameter.
func MapEvent(tenantID, stream string, raw []byte, fetchedAtUnix int64) ocsf.Event {
	var rec rawEventRecord
	parsedWrapper := json.Unmarshal(raw, &rec) == nil

	var item activityItem
	parsedItem := parsedWrapper && json.Unmarshal(rec.Item, &item) == nil

	var event activityEvent
	hasEvent := parsedItem && rec.EventIndex >= 0 && rec.EventIndex < len(item.Events)
	if hasEvent {
		event = item.Events[rec.EventIndex]
	}

	timeMillis, offset := fetchedAtUnix*1000, "Z"
	if parsedItem && item.ID.Time != "" {
		if ms, off, ok := parseGoogleTimestamp(item.ID.Time); ok {
			timeMillis, offset = ms, off
		}
	}

	ev := ocsf.Event{
		EventID:        eventID(tenantID, stream, item.ID.UniqueQualifier, rec.EventIndex, raw),
		SchemaVersion:  SchemaVersion,
		TimeUnixMillis: timeMillis,
		TimeOffset:     offset,
		TenantID:       tenantID,
		// "product" is the one field services/detect/internal/dispatch uses
		// to find candidate rules at all (see m365's identical comment) —
		// deliberately "google_workspace" (not "m365"), which is exactly why
		// the existing impossible-travel.yml rule structurally cannot match
		// a Google event: it is pinned to product=m365. See
		// detections/rules/impossible-travel-google.yml, added alongside
		// this package, rather than loosening that rule's own guarantees.
		Metadata: map[string]string{"source": "google_workspace", "content_type": stream, "product": "google_workspace", "operation": event.Name},
		RawData:  raw,
	}

	if !hasEvent {
		ev.ClassUID, ev.CategoryUID, ev.ActivityID, ev.TypeUID = 0, 0, 0, 0
		ev.Unmapped = unmappedFields(item, event, raw, parsedItem, false)
		return ev
	}

	mapping, ok := lookupMapping(item.ID.ApplicationName, event)
	if !ok {
		ev.ClassUID, ev.CategoryUID, ev.ActivityID, ev.TypeUID = 0, 0, 0, 0
		ev.Unmapped = unmappedFields(item, event, raw, parsedItem, false)
		return ev
	}

	ev.ClassUID, ev.CategoryUID, ev.ActivityID = mapping.ClassUID, mapping.CategoryUID, mapping.ActivityID
	ev.TypeUID = mapping.ClassUID*100 + mapping.ActivityID
	ev.Unmapped = unmappedFields(item, event, raw, parsedItem, true)
	return ev
}

// lookupMapping resolves one event to its activityMapping — gmail's
// "delivery" eventName is a special case keyed by its mail_event_type
// parameter rather than by eventName itself (see gmailEventTypeMappings'
// own doc comment).
func lookupMapping(applicationName string, event activityEvent) (activityMapping, bool) {
	if applicationName == "gmail" && event.Name == "delivery" {
		for _, p := range event.Parameters {
			if p.Name != "mail_event_type" || p.IntValue == "" {
				continue
			}
			n, err := strconv.ParseInt(p.IntValue, 10, 64)
			if err != nil {
				return activityMapping{}, false
			}
			m, ok := gmailEventTypeMappings[n]
			return m, ok
		}
		return activityMapping{}, false
	}
	m, ok := activityMappings[applicationName+"/"+event.Name]
	return m, ok
}

// unmappedFields is AC2's equivalent for Google: every vendor field this
// mapping does not translate into a typed OCSF field is preserved here
// rather than discarded, stringified to match the unmapped Map(String,String)
// column exactly as m365's own unmappedFields does. eventMapped controls
// whether "eventName" itself is excluded, mirroring the mapped/unmapped
// branch split m365 already established.
func unmappedFields(item activityItem, event activityEvent, raw []byte, parsed, eventMapped bool) map[string]string {
	if !parsed {
		return map[string]string{"_raw": string(raw)}
	}
	out := map[string]string{
		"applicationName": item.ID.ApplicationName,
		"actorEmail":      item.Actor.Email,
		"ipAddress":       item.IPAddress,
		"uniqueQualifier": item.ID.UniqueQualifier,
		"eventType":       event.Type,
	}
	if !eventMapped {
		out["eventName"] = event.Name
	}
	for _, p := range event.Parameters {
		switch {
		case p.Value != "":
			out[p.Name] = p.Value
		case p.IntValue != "":
			out[p.Name] = p.IntValue
		case p.BoolValue != nil:
			out[p.Name] = strconv.FormatBool(*p.BoolValue)
		}
	}
	return out
}

// parseGoogleTimestamp accepts the RFC3339-with-milliseconds form Google's
// Reports API actually returns ("2024-01-01T00:00:00.000Z") as well as
// plain RFC3339 without a fractional component, for robustness — returning
// false (never an error) for anything else, since MapEvent must stay total.
func parseGoogleTimestamp(s string) (unixMillis int64, offset string, ok bool) {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.UTC().UnixMilli(), formatOffset(t), true
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.UTC().UnixMilli(), formatOffset(t), true
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
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

// eventID is this package's version of m365's eventID — UUIDv5 (SHA-1),
// deterministic, never random, keyed on the vendor's own uniqueQualifier
// plus which event within the item this is (a multi-event item's events
// share one uniqueQualifier but must still each get a distinct, stable id).
// Falls back to hashing the entire raw payload when uniqueQualifier is
// empty, same total-function guarantee m365 makes.
func eventID(tenantID, stream, uniqueQualifier string, eventIndex int, raw []byte) string {
	name := tenantID + "|google_workspace|" + stream + "|" + uniqueQualifier + "|" + strconv.Itoa(eventIndex)
	if uniqueQualifier == "" {
		name = tenantID + "|google_workspace|" + stream + "|" + string(raw)
	}
	return "evt_" + uuid.NewSHA1(eventIDNamespace, []byte(name)).String()
}
