// Package ocsf is a deliberately minimal placeholder for the Open
// Cybersecurity Schema Framework event shape referenced by
// docs/architecture/overview.md §3.1 and formalised in ADR-0002.
//
// P1-01 only needs ENOUGH of an ocsf.Event to make Connector.Normalise's
// signature real and testable — the base fields every OCSF event class
// shares. Full per-category conformance (the specific fields an
// Authentication event needs versus a File Activity event, M365's actual
// activity-to-OCSF-class mapping, validation against the OCSF JSON schemas)
// is P1-04's ticket, not this one. Treat every field below as stable; treat
// the TYPE as incomplete.
package ocsf

// Event is the OCSF base event envelope: the fields the spec requires on
// every event class, regardless of category. See
// https://schema.ocsf.io/1.3.0/classes/base_event for the full base class
// this is a subset of.
type Event struct {
	// ClassUID identifies the specific OCSF event class (e.g. 3002 for
	// Authentication). TypeUID is ClassUID*100 + ActivityID by OCSF
	// convention — computed by whoever constructs this, not by this package,
	// since P1-01 has no class-specific knowledge to compute it correctly.
	ClassUID    int64
	CategoryUID int64
	ActivityID  int64
	TypeUID     int64
	SeverityID  int64

	// TimeUnixMillis is the event's own timestamp, from the vendor source —
	// never FetchedAt from the raw event; a connector normalising a batch
	// fetched now but describing activity from an hour ago must preserve
	// that hour-old timestamp here.
	TimeUnixMillis int64

	TenantID string

	// Metadata carries OCSF's required product/version envelope. Left as a
	// map rather than a typed struct until P1-04 defines what this product
	// needs it to actually contain.
	Metadata map[string]string

	// RawData preserves the original vendor payload verbatim alongside the
	// normalised fields — OCSF's own recommendation, and the only way a
	// human investigating an alert can go back to source truth when a
	// normalisation mapping turns out to be wrong.
	RawData []byte
}
