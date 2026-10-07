// Package sentinelsignal is P2-04's wire shape for the `signals` topic
// (go/sentinelstream.Signals) — the detection engine's own output, and the
// one thing the correlation plane (P3) will read it back as. Kept as its
// own tiny module rather than folded into services/detect/internal/worker
// so a future P3 consumer depends on this shape alone, not on the whole
// detection worker.
package sentinelsignal

import "time"

// Signal is one compiled rule's match against one normalised event — P2-04
// AC: "every emitted signal references the event_id that produced it" and
// "signals carry rule id, MITRE technique, severity and tenant".
type Signal struct {
	SignalID   string    `json:"signal_id"`
	EventID    string    `json:"event_id"`
	TenantID   string    `json:"tenant_id"`
	RuleID     string    `json:"rule_id"`
	RuleTitle  string    `json:"rule_title"`
	MitreIDs   []string  `json:"mitre_ids"`
	Severity   string    `json:"severity"`
	Engine     string    `json:"engine"`
	DetectedAt time.Time `json:"detected_at"`
}
