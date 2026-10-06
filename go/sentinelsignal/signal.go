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
	SignalID   string    `json:"signal_id"`
	EventIDs   []string  `json:"event_ids"`
	TenantID   string    `json:"tenant_id"`
	RuleID     string    `json:"rule_id"`
	RuleTitle  string    `json:"rule_title"`
	MitreIDs   []string  `json:"mitre_ids"`
	Severity   string    `json:"severity"`
	Engine     string    `json:"engine"`
	EntityType string    `json:"entity_type,omitempty"`
	EntityID   string    `json:"entity_id,omitempty"`
	DetectedAt time.Time `json:"detected_at"`
}
