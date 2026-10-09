package sigmac

// fieldMap is AC1's "explicit, reviewable mapping table" from a Sigma
// rule's own field names onto an OCSF-shaped path the evaluator (P2-03/
// P2-04) will read from a normalised event. Grounded in what
// go/sentinelconnector/ocsf.Event actually has today (ADR-0004's own
// examples: "class_uid, activity_id, metadata.product") rather than the
// full published OCSF schema that struct doesn't implement yet:
//
//   - "metadata.<key>" and "unmapped.<key>" read ocsf.Event's two
//     map[string]string fields — Unmapped specifically holds every M365
//     field P1-04's own mapping didn't translate into a typed field
//     (ocsf_mapping.go's own doc comment), which is where most of a
//     Sigma rule's own field references land.
//   - bare names (class_uid, activity_id, category_uid, severity_id,
//     tenant_id) read ocsf.Event's typed fields directly.
//
// Adding a field a rule needs is an edit to this table, reviewed like
// any other code change — never an implicit fallback, which is exactly
// what AC4/T4 exist to rule out ("field mapping failure... is an error,
// not a silent no-match").
var fieldMap = map[string]string{
	"EventID":   "metadata.event_id",
	"Operation": "metadata.operation",
	"Workload":  "metadata.content_type",

	"UserId":                 "unmapped.UserId",
	"ClientIP":               "unmapped.ClientIP",
	"ClientIPAddress":        "unmapped.ClientIPAddress",
	"ResultStatus":           "unmapped.ResultStatus",
	"ObjectId":               "unmapped.ObjectId",
	"ApplicationId":          "unmapped.ApplicationId",
	"ApplicationDisplayName": "unmapped.ApplicationDisplayName",
	"Parameters":             "unmapped.Parameters",
	"CommandLine":            "unmapped.CommandLine",
	"Image":                  "unmapped.Image",

	// P2-06 additions — one new field per new rule that needs a raw M365
	// audit-log attribute this table didn't carry yet. Same convention as
	// every entry above: a value the rule's own selection compares
	// against, not something this package derives or infers.
	"ClientAppUsed":           "unmapped.ClientAppUsed",
	"AuditEnabled":            "unmapped.AuditEnabled",
	"MarkAsRead":              "unmapped.MarkAsRead",
	"PolicyState":             "unmapped.PolicyState",
	"ConsentType":             "unmapped.ConsentType",
	"UserType":                "unmapped.UserType",
	"TargetUserOrGroupType":   "unmapped.TargetUserOrGroupType",
	"AuditBypassEnabled":      "unmapped.AuditBypassEnabled",
	"PasswordNeverExpires":    "unmapped.PasswordNeverExpires",
	"EnableSafeAttachments":   "unmapped.EnableSafeAttachments",
	"RemotePowerShellEnabled": "unmapped.RemotePowerShellEnabled",

	// P2-13 addition — docs/detection-engineering-guide.md's own worked
	// example (adding tenant-audit-log-disabled.yml).
	"UnifiedAuditLogIngestionEnabled": "unmapped.UnifiedAuditLogIngestionEnabled",

	// P7-01 additions — one new field per new rule, same convention as
	// every addition above, for the first non-M365 connector
	// (go/sentinelconnector/google). Lowercase-first because that's the
	// exact key google.MapEvent's own unmappedFields stamps — Unmapped map
	// keys mirror each vendor's own field-name casing verbatim, never
	// normalised, so these two names are deliberately NOT capitalised like
	// the M365 entries above them.
	"ActorEmail": "unmapped.actorEmail",
	"IPAddress":  "unmapped.ipAddress",

	// P2-09 additions — not a raw M365 field at all, but the local
	// threat-intel enrichment (go/sentinelenrich) attaches at dispatch
	// time, keyed by the event's own ClientIP. Landing in the
	// "metadata." namespace rather than "unmapped.": these values are
	// never anything a vendor sent, which is exactly what "unmapped"
	// means elsewhere in this table — they are this pipeline's OWN
	// derived metadata about the event, the same category
	// "metadata.product"/"metadata.operation" already occupy.
	"IsAnonymousProxy":  "metadata.is_anonymous_proxy",
	"IsVPN":             "metadata.is_vpn",
	"IsHostingProvider": "metadata.is_hosting_provider",
	"GeoCountry":        "metadata.geo_country",
	"GeoASN":            "metadata.geo_asn",

	"class_uid":    "class_uid",
	"category_uid": "category_uid",
	"activity_id":  "activity_id",
	"severity_id":  "severity_id",
	"tenant_id":    "tenant_id",
}

// mapField is the one place this package ever consults fieldMap — AC4/T4:
// an unknown field is an error (ok=false), never a path the evaluator
// would silently fail to match against.
func mapField(sigmaField string) (ocsfPath string, ok bool) {
	path, ok := fieldMap[sigmaField]
	return path, ok
}

// MapField is mapField, exported for P2-05's windowed query compiler
// (services/detect/internal/windowed) — a windowed rule's own Aggregation
// still names group-by fields by their raw Sigma field name (condition.go's
// parseAggregation never runs them through this table, only validates them
// against it), so the query compiler needs this same translation itself
// rather than inventing a second one.
func MapField(sigmaField string) (ocsfPath string, ok bool) {
	return mapField(sigmaField)
}
