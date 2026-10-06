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
