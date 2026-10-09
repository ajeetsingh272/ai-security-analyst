// P7-03: OCSF normalisation for Azure/Entra ID diagnostic-settings log
// records (sign-in logs, audit logs, Identity Protection risk
// detections), exported via Event Hub. The fourth connector.
//
// AC5's "overlap with M365-sourced events is deduplicated" is this
// file's own central design problem, resolved deliberately (not
// discovered mid-implementation): Entra's sign-in/audit logs and M365's
// own Audit.AzureActiveDirectory content (go/sentinelconnector/m365)
// read the SAME underlying Azure AD audit record store through two
// different export paths — diagnostic settings vs. the Office 365
// Management Activity API. The same real-world event therefore carries
// the SAME intrinsic record GUID (properties.id) regardless of which
// path surfaced it. For every event category this package can map onto
// one of M365's own existing families, MapEvent deliberately computes
// its EventID using M365's OWN eventID formula (same namespace UUID,
// same "<tenant>|m365|Audit.AzureActiveDirectory|<id>" pre-hash string —
// see m365EventIDNamespace below) keyed on that shared GUID, and
// deliberately stamps the SAME Metadata (product="m365", operation=the
// identical M365 Operation literal) an M365-sourced copy of this event
// would carry. Two consequences, both intended:
//   - ClickHouse's ReplacingMergeTree collapses the two connectors'
//     copies into one stored row, keyed on (tenant_id, event_id) —
//     AC5's own literal requirement.
//   - Whichever copy a background merge happens to keep "wins" looking
//     byte-for-byte like an M365 event either way, so every EXISTING
//     M365-keyed detection rule (impossible-travel.yml and 20+ others,
//     all selecting on Operation/ResultStatus/product=m365) keeps
//     matching consistently — not only when M365's own copy happens to
//     survive the merge. Mimicking M365's shape here is what makes that
//     true; using Azure's own distinct product tag for these categories
//     would silently leave that outcome to merge-order luck.
//
// Risk detections (AC2) have NO M365 equivalent at all (confirmed: no
// "risk"/"Identity Protection" row exists anywhere in m365's own mapping
// table) — those get Azure's own distinct identity (product="azure",
// eventIDNamespace below), nothing to deduplicate against.
//
// Event/class/activity values verified against Microsoft's own
// documented Entra ID diagnostic-log schema and the live OCSF 1.3.0
// schema (schema.ocsf.io/1.3.0/classes/...) while writing this file —
// reviewers should re-verify rather than trusting this comment, same
// discipline m365/google/aws's own mapping files already establish.
package azure

import (
	"encoding/json"
	"time"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector/ocsf"
	"github.com/google/uuid"
)

const SchemaVersion = "azure-entra-ocsf-v1"

// m365EventIDNamespace and m365ContentType are go/sentinelconnector/m365's
// OWN eventIDNamespace/content-type literal, duplicated here deliberately
// (not imported — this package has no other reason to depend on m365,
// and the whole point is computing the SAME hash m365's own eventID
// function would, not calling into that package) so an overlapping
// event's EventID collides with what m365.MapEvent would have produced
// for the equivalent Audit.AzureActiveDirectory record. If m365's own
// namespace or content-type string EVER changes, this must change with
// it — TestMapEvent_DedupesAgainstM365Equivalents (ocsf_mapping_test.go)
// fails immediately if the two packages ever drift apart.
var m365EventIDNamespace = uuid.MustParse("5c1e5f1a-7f3b-4c2a-9c3d-6f0a1b2c3d4e")

const m365ContentType = "Audit.AzureActiveDirectory"

// azureEventIDNamespace is this package's OWN namespace, used only for
// categories with no M365 equivalent (risk detections) or an
// unrecognised/unparsable record — never for anything meant to
// deduplicate against M365.
var azureEventIDNamespace = uuid.MustParse("2b6d4f8a-9c1e-4a3d-8b5f-7e0a2c4d6f8b")

type activityMapping struct {
	ClassUID    int64
	CategoryUID int64
	ActivityID  int64
	// m365Operation is non-empty exactly for mappings that must
	// deduplicate against M365 — see the package doc comment. When set,
	// MapEvent stamps Metadata["operation"] with THIS value (an M365
	// Operation literal, e.g. "Add user.") instead of the Entra record's
	// own operationName/activityDisplayName, and computes EventID via
	// m365EventIDNamespace/m365ContentType rather than this package's own.
	m365Operation string
}

// signInMappings is keyed by nothing at all — every sign-in log record
// maps to the identical family M365's own "UserLoggedIn" uses,
// regardless of result. (OCSF's own Authentication class doesn't
// distinguish success/failure on activity_id either — see m365's
// identical comment on its own UserLoggedIn row.) Success/failure and
// conditional-access outcome are preserved as Unmapped fields on the
// same event instead (AC2's "conditional access results are captured").
var signInMapping = activityMapping{ClassUID: 3002, CategoryUID: 3, ActivityID: 1, m365Operation: "UserLoggedIn"}

// auditMappings is keyed by the Entra audit log's own activityDisplayName
// — mirrors m365's own operationMappings table one row at a time, using
// the IDENTICAL m365Operation literal m365's own table already maps,
// so an overlapping record collides with M365's copy both in EventID
// and in Metadata shape.
//
// Deliberately a REPRESENTATIVE subset of M365's own Audit.AzureActiveDirectory
// vocabulary, not the exhaustive list — m365's own operationMappings has
// 11 AzureActiveDirectory-sourced rows (the mail/file families are
// Exchange/SharePoint-sourced and have no Entra-diagnostic-log
// equivalent at all, legitimately out of this package's scope); this
// table covers 8 of those 11. "Disable account.", "Add group." and
// "Delete group." are NOT yet mirrored here — an Azure-sourced copy of
// one of those three specific operations will NOT currently deduplicate
// with, or trigger the same existing M365-keyed detection rules as, an
// M365-sourced copy of the same event. Extending this table with their
// real Entra activityDisplayName strings (verified against a live
// tenant's own audit log, not guessed) is additive follow-up work, not
// a correctness fix to what's already here.
var auditMappings = map[string]activityMapping{
	"Add user":                             {ClassUID: 3001, CategoryUID: 3, ActivityID: 1, m365Operation: "Add user."},
	"Delete user":                          {ClassUID: 3001, CategoryUID: 3, ActivityID: 6, m365Operation: "Delete user."},
	"Reset password (by admin)":            {ClassUID: 3001, CategoryUID: 3, ActivityID: 4, m365Operation: "Reset user password."},
	"Change password (self-service)":       {ClassUID: 3001, CategoryUID: 3, ActivityID: 3, m365Operation: "Change user password."},
	"Add member to group":                  {ClassUID: 3006, CategoryUID: 3, ActivityID: 3, m365Operation: "Add member to group."},
	"Remove member from group":             {ClassUID: 3006, CategoryUID: 3, ActivityID: 4, m365Operation: "Remove member from group."},
	"Consent to application":               {ClassUID: 3005, CategoryUID: 3, ActivityID: 1, m365Operation: "Consent to application."},
	"Remove app role assignment from user": {ClassUID: 3005, CategoryUID: 3, ActivityID: 2, m365Operation: "Remove OAuth2PermissionGrant."},
}

// riskDetectionMapping: Identity Protection risk detections have no M365
// equivalent at all — OCSF's Detection Finding (2004, category 2) is the
// documented home for "detections or alerts generated by security
// products using correlation engines" (its own schema description),
// which is exactly what Identity Protection's risk engine is. Every
// exported riskDetection record is logged once as a new finding in this
// export stream, so Create(1) throughout rather than modelling
// dismiss/remediate as separate Update/Close activities this ticket's
// own scope doesn't ask for.
var riskDetectionClassUID, riskDetectionCategoryUID, riskDetectionActivityID int64 = 2004, 2, 1

type CoverageEntry struct {
	Key                  string
	ClassUID             int64
	CategoryUID          int64
	ActivityID           int64
	DeduplicatesWithM365 bool
}

func CoverageReport() []CoverageEntry {
	out := []CoverageEntry{
		{Key: "signInLogs/*", ClassUID: signInMapping.ClassUID, CategoryUID: signInMapping.CategoryUID, ActivityID: signInMapping.ActivityID, DeduplicatesWithM365: true},
		{Key: "riskDetections/*", ClassUID: riskDetectionClassUID, CategoryUID: riskDetectionCategoryUID, ActivityID: riskDetectionActivityID, DeduplicatesWithM365: false},
	}
	for name, m := range auditMappings {
		out = append(out, CoverageEntry{Key: "auditLogs/" + name, ClassUID: m.ClassUID, CategoryUID: m.CategoryUID, ActivityID: m.ActivityID, DeduplicatesWithM365: true})
	}
	return out
}

// entraRecord is the subset of fields this mapping reads from one
// Azure Monitor diagnostic-log record — every category (SignInLogs,
// AuditLogs, RiskDetections) shares this same outer envelope
// (https://learn.microsoft.com/en-us/azure/azure-monitor/essentials/resource-logs-schema),
// differing only in the nested properties object's own shape.
type entraRecord struct {
	Time          string          `json:"time"`
	Category      string          `json:"category"` // "SignInLogs" | "AuditLogs" | "RiskDetections" (also seen as "UserRiskEvents"/"RiskyUsers" depending on export config)
	OperationName string          `json:"operationName"`
	TenantIDAAD   string          `json:"tenantId"` // Azure AD tenant GUID — informational only; Sentinel's own tenantID (the MapEvent parameter) is what the event is scoped by
	Properties    json.RawMessage `json:"properties"`
}

type signInProperties struct {
	ID                      string `json:"id"`
	UserPrincipalName       string `json:"userPrincipalName"`
	IPAddress               string `json:"ipAddress"`
	ResultType              string `json:"resultType"`
	ResultSignature         string `json:"resultSignature"`
	ConditionalAccessStatus string `json:"conditionalAccessStatus"`
	RiskLevelDuringSignIn   string `json:"riskLevelDuringSignIn"`
	RiskState               string `json:"riskState"`
	AppDisplayName          string `json:"appDisplayName"`
}

type auditProperties struct {
	ID                  string `json:"id"`
	ActivityDisplayName string `json:"activityDisplayName"`
	Category            string `json:"category"`
	Result              string `json:"result"`
}

type riskProperties struct {
	ID                string `json:"id"`
	RiskEventType     string `json:"riskEventType"`
	RiskLevel         string `json:"riskLevel"`
	RiskState         string `json:"riskState"`
	UserPrincipalName string `json:"userPrincipalName"`
	IPAddress         string `json:"ipAddress"`
}

// MapEvent is this package's version of m365.MapEvent/google.MapEvent/aws.MapEvent
// — pure, total, deterministic, no I/O/clock/injected client. stream is
// always "entra-diagnostics" (connector.go's own Stream const) — Azure
// diagnostic settings typically multiplex every log category into one
// Event Hub, differentiated by each record's own "category" field, not
// by separate Event Hubs/partitions a customer would have to configure
// per category.
func MapEvent(tenantID, stream string, raw []byte, fetchedAtUnix int64) ocsf.Event {
	var rec entraRecord
	parsed := json.Unmarshal(raw, &rec) == nil

	timeMillis, offset := fetchedAtUnix*1000, "Z"
	if parsed && rec.Time != "" {
		if ms, off, ok := parseEntraTimestamp(rec.Time); ok {
			timeMillis, offset = ms, off
		}
	}

	switch {
	case parsed && rec.Category == "SignInLogs":
		return mapSignIn(tenantID, rec, raw, timeMillis, offset)
	case parsed && rec.Category == "AuditLogs":
		return mapAudit(tenantID, rec, raw, timeMillis, offset)
	case parsed && (rec.Category == "RiskDetections" || rec.Category == "UserRiskEvents" || rec.Category == "RiskyUsers"):
		return mapRiskDetection(tenantID, rec, raw, timeMillis, offset)
	default:
		ev := ocsf.Event{
			EventID:        azureEventID(tenantID, stream, "", raw),
			SchemaVersion:  SchemaVersion,
			TimeUnixMillis: timeMillis,
			TimeOffset:     offset,
			TenantID:       tenantID,
			Metadata:       map[string]string{"source": "azure", "content_type": stream, "product": "azure", "operation": rec.OperationName},
			RawData:        raw,
			Unmapped:       unmappedFields(raw, parsed),
		}
		return ev
	}
}

func mapSignIn(tenantID string, rec entraRecord, raw []byte, timeMillis int64, offset string) ocsf.Event {
	var props signInProperties
	_ = json.Unmarshal(rec.Properties, &props)

	ev := ocsf.Event{
		EventID:        m365CompatibleEventID(tenantID, props.ID, raw),
		SchemaVersion:  SchemaVersion,
		TimeUnixMillis: timeMillis,
		TimeOffset:     offset,
		TenantID:       tenantID,
		ClassUID:       signInMapping.ClassUID,
		CategoryUID:    signInMapping.CategoryUID,
		ActivityID:     signInMapping.ActivityID,
		TypeUID:        signInMapping.ClassUID*100 + signInMapping.ActivityID,
		// Deliberately mimics m365's own sign-in Metadata shape — see
		// this file's own package doc comment for why.
		Metadata: map[string]string{"source": "m365", "content_type": m365ContentType, "product": "m365", "operation": signInMapping.m365Operation},
		RawData:  raw,
		Unmapped: map[string]string{
			"UserId": props.UserPrincipalName, "ClientIP": props.IPAddress,
			// ResultStatus mirrors the exact literal m365's own ResultStatus
			// field uses ("Success"/"Failed") so impossible-travel.yml's own
			// selection (ResultStatus: 'Success') matches a deduplicated
			// Azure-sourced copy exactly the same way it matches M365's.
			"ResultStatus": entraResultStatus(props.ResultType),
			// Azure-only fields with no M365 counterpart — preserved, never
			// discarded, under their own names (AC2's "conditional access
			// results are captured").
			"conditionalAccessStatus": props.ConditionalAccessStatus,
			"riskLevelDuringSignIn":   props.RiskLevelDuringSignIn,
			"riskState":               props.RiskState,
			"appDisplayName":          props.AppDisplayName,
		},
	}
	return ev
}

func entraResultStatus(resultType string) string {
	if resultType == "0" {
		return "Success"
	}
	return "Failed"
}

func mapAudit(tenantID string, rec entraRecord, raw []byte, timeMillis int64, offset string) ocsf.Event {
	var props auditProperties
	_ = json.Unmarshal(rec.Properties, &props)

	mapping, ok := auditMappings[props.ActivityDisplayName]
	if !ok {
		return ocsf.Event{
			EventID:        azureEventID(tenantID, "auditLogs", props.ID, raw),
			SchemaVersion:  SchemaVersion,
			TimeUnixMillis: timeMillis,
			TimeOffset:     offset,
			TenantID:       tenantID,
			Metadata:       map[string]string{"source": "azure", "content_type": "auditLogs", "product": "azure", "operation": props.ActivityDisplayName},
			RawData:        raw,
			Unmapped:       unmappedFields(raw, true),
		}
	}

	return ocsf.Event{
		EventID:        m365CompatibleEventID(tenantID, props.ID, raw),
		SchemaVersion:  SchemaVersion,
		TimeUnixMillis: timeMillis,
		TimeOffset:     offset,
		TenantID:       tenantID,
		ClassUID:       mapping.ClassUID,
		CategoryUID:    mapping.CategoryUID,
		ActivityID:     mapping.ActivityID,
		TypeUID:        mapping.ClassUID*100 + mapping.ActivityID,
		Metadata:       map[string]string{"source": "m365", "content_type": m365ContentType, "product": "m365", "operation": mapping.m365Operation},
		RawData:        raw,
		Unmapped:       map[string]string{"ResultStatus": props.Result},
	}
}

func mapRiskDetection(tenantID string, rec entraRecord, raw []byte, timeMillis int64, offset string) ocsf.Event {
	var props riskProperties
	_ = json.Unmarshal(rec.Properties, &props)

	return ocsf.Event{
		EventID:        azureEventID(tenantID, "riskDetections", props.ID, raw),
		SchemaVersion:  SchemaVersion,
		TimeUnixMillis: timeMillis,
		TimeOffset:     offset,
		TenantID:       tenantID,
		ClassUID:       riskDetectionClassUID,
		CategoryUID:    riskDetectionCategoryUID,
		ActivityID:     riskDetectionActivityID,
		TypeUID:        riskDetectionClassUID*100 + riskDetectionActivityID,
		// No M365 equivalent exists — this is Azure's own, undeduplicated
		// identity, deliberately distinct from the sign-in/audit mappings
		// above.
		Metadata: map[string]string{"source": "azure", "content_type": "riskDetections", "product": "azure", "operation": props.RiskEventType},
		RawData:  raw,
		Unmapped: map[string]string{
			"UserId": props.UserPrincipalName, "ClientIP": props.IPAddress,
			"riskLevel": props.RiskLevel, "riskState": props.RiskState,
		},
	}
}

// unmappedFields preserves every field this struct didn't read by name
// — same total-preservation discipline every other connector's own
// mapping file uses. Flattens the one level of nesting this schema
// actually has ("properties") into the same flat map, rather than
// leaving it as an opaque JSON-encoded string: Sigma-style detection
// rules select on flat field names (see services/detect/internal/sigmac's
// own fieldMap, which every other connector's Unmapped keys already
// have to be flat for), and a field like activityDisplayName living only
// inside an un-flattened "properties" blob would be invisible to them.
func unmappedFields(raw []byte, parsed bool) map[string]string {
	if !parsed {
		return map[string]string{"_raw": string(raw)}
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(raw, &all); err != nil {
		return map[string]string{"_raw": string(raw)}
	}
	out := make(map[string]string, len(all))
	for k, v := range all {
		if k == "time" {
			continue
		}
		if k == "properties" {
			var props map[string]json.RawMessage
			if err := json.Unmarshal(v, &props); err == nil {
				for pk, pv := range props {
					out[pk] = rawJSONToString(pv)
				}
				continue
			}
		}
		out[k] = rawJSONToString(v)
	}
	return out
}

// rawJSONToString unquotes a JSON string value to its plain text form
// (so Unmapped["userPrincipalName"] is "alice@contoso.com", not
// "\"alice@contoso.com\""); any other JSON value type (number, bool,
// object, array) is preserved as its own literal JSON text instead.
func rawJSONToString(v json.RawMessage) string {
	s := string(v)
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		var unquoted string
		if err := json.Unmarshal(v, &unquoted); err == nil {
			return unquoted
		}
	}
	return s
}

func parseEntraTimestamp(s string) (unixMillis int64, offset string, ok bool) {
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.UTC().UnixMilli(), "Z", true
	}
	return 0, "", false
}

// m365CompatibleEventID is the package doc comment's own deliberate
// collision: identical namespace, identical pre-hash format, to
// m365.MapEvent's own eventID — see that package's ocsf_mapping.go for
// the formula being mirrored.
func m365CompatibleEventID(tenantID, vendorID string, raw []byte) string {
	name := tenantID + "|m365|" + m365ContentType + "|" + vendorID
	if vendorID == "" {
		name = tenantID + "|m365|" + m365ContentType + "|" + string(raw)
	}
	return "evt_" + uuid.NewSHA1(m365EventIDNamespace, []byte(name)).String()
}

// azureEventID is this package's OWN deterministic id — used only where
// there is nothing to deduplicate against.
func azureEventID(tenantID, stream, vendorID string, raw []byte) string {
	name := tenantID + "|azure|" + stream + "|" + vendorID
	if vendorID == "" {
		name = tenantID + "|azure|" + stream + "|" + string(raw)
	}
	return "evt_" + uuid.NewSHA1(azureEventIDNamespace, []byte(name)).String()
}
