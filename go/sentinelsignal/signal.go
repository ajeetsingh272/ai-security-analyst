// Package sentinelsignal is P2-04's wire shape for the `signals` topic
// (go/sentinelstream.Signals) — the detection engine's own output, and the
// one thing the correlation plane (P3) will read it back as. Kept as its
// own tiny module rather than folded into services/detect/internal/worker
// so a future P3 consumer depends on this shape alone, not on the whole
// detection worker.
package sentinelsignal

import "time"

// Signal is one compiled rule's match — P2-04's in-stream AC ("every
// emitted signal references the event_id that produced it"; "signals
// carry rule id, MITRE technique, severity and tenant") plus P2-05's own
// widening for a windowed rule's result, which is never about one event.
//
// EventIDs is plural (not EventID) to match db/clickhouse/0001_events.sql's
// own `sentinel.signals` table — its `event_ids Array(String)` column
// already anticipated this; this struct briefly regressed to singular when
// P2-04 shipped before P2-05 needed the plural case, and is corrected here
// rather than left to drift further from the table it will eventually be
// written into. An in-stream signal is simply the one-element case.
//
// EntityType/EntityID mirror the same table's own columns — for a windowed
// rule, "the entity this signal is about" (e.g. a UserId) is known at
// detection time and worth carrying, even though P3 (correlation) is what
// will eventually resolve entities for every signal generally.
type Signal struct {
	SignalID   string   `json:"signal_id"`
	EventIDs   []string `json:"event_ids"`
	TenantID   string   `json:"tenant_id"`
	RuleID     string   `json:"rule_id"`
	RuleTitle  string   `json:"rule_title"`
	MitreIDs   []string `json:"mitre_ids"`
	Severity   string   `json:"severity"`
	Engine     string   `json:"engine"`
	EntityType string   `json:"entity_type,omitempty"`
	EntityID   string   `json:"entity_id,omitempty"`
	// DedupeKey is P2-08/TG4's own addition — deterministic and stable
	// for "the same underlying detection", independent of which pipeline
	// run produced it or what random SignalID that run generated. A
	// critical signal publishes to BOTH `signals` (for correlation) and
	// `alerts.critical` (the direct bypass) carrying the identical
	// DedupeKey, so a future notifier can collapse a bypass alert and
	// its later AI-investigated counterpart into exactly one customer
	// notification (AC4) without needing to compare anything else about
	// the two messages. See NewDedupeKey for how it's derived.
	DedupeKey string `json:"dedupe_key"`
	// OwnerDescription carries the rule's own plain-English explanation
	// (P2-06) onto the wire — AC3's "clearly labelled as rule-generated
	// rather than AI-investigated": a bypass alert's body is this text
	// verbatim, never a narrative an AI wrote, which is also exactly
	// what overview.md §3.5 means by "degraded to the rule's own
	// description instead of a narrative".
	OwnerDescription string    `json:"owner_description,omitempty"`
	DetectedAt       time.Time `json:"detected_at"`
}

// NewDedupeKey derives Signal.DedupeKey from the content that actually
// identifies "the same underlying detection" — tenant, rule, and
// whichever of entityID/eventIDs the signal has. entityID is preferred
// when present (a windowed rule's own grouping key, e.g. a UserId,
// stays the same across repeated ticks of the SAME ongoing violation,
// whereas its contributing EventIDs do not); an in-stream signal has no
// entity yet (P3's own job generally), so its first event id is the
// next best stable identifier. Two calls with the same inputs always
// produce the same key — that equality, not any particular format, is
// the only property a caller may depend on.
func NewDedupeKey(tenantID, ruleID, entityID string, eventIDs []string) string {
	key := tenantID + ":" + ruleID
	if entityID != "" {
		return key + ":" + entityID
	}
	if len(eventIDs) > 0 {
		return key + ":" + eventIDs[0]
	}
	return key
}
