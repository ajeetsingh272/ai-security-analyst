// Package scoring is P3-04: score a case deterministically, before any
// LLM sees it, from entity criticality, signal count, the highest
// constituent severity, MITRE kill-chain progression, and tenant
// baseline deviation (docs/architecture/overview.md §3.6).
//
// Score is pure — no I/O, no clock, no randomness — so the same Input
// always produces the identical Result (AC5), and the result's own
// Components always sum to exactly its Total (AC4), which is what
// "stored score components reproduce the final score exactly" means in
// practice: nothing is computed and then discarded before storage.
// Store.Recompute (store.go) is the thin, Postgres-aware wrapper that
// gathers an Input from case_signals/entity_criticality and persists
// the Result — mirroring internal/lifecycle's own pure-core/DB-shell
// split.
package scoring

import (
	"sort"

	"github.com/ajeetsingh272/ai-security-analyst/go/sentinelattck"
)

// Criticality is an entity's own flagged importance
// (entity_criticality.criticality) — "high" for an identity a case
// touching it should always outrank an equivalent case on an ordinary
// one (AC2/T2).
type Criticality string

const (
	CriticalityNormal Criticality = "normal"
	CriticalityHigh   Criticality = "high"
)

// Severity mirrors cases/case_signals' own severity values
// (0001_foundation.sql's CHECK constraint).
type Severity string

const (
	SeverityCritical Severity = "critical"
	SeverityHigh     Severity = "high"
	SeverityMedium   Severity = "medium"
	SeverityLow      Severity = "low"
	SeverityInfo     Severity = "info"
)

var severityWeight = map[Severity]float64{
	SeverityCritical: 20,
	SeverityHigh:     15,
	SeverityMedium:   10,
	SeverityLow:      5,
	SeverityInfo:     0,
}

// Input is everything Score needs about one case, gathered from
// whatever source a caller chooses (Store.Recompute gathers it from
// Postgres; a unit test builds it by hand).
type Input struct {
	// SignalCount is the number of signals clustered into this case.
	SignalCount int
	// Severities is every constituent signal's own severity — only the
	// highest contributes (AC: "highest constituent severity"), but the
	// full set is taken rather than a pre-reduced maximum so Score
	// itself owns that reduction and a caller can't disagree with it.
	Severities []Severity
	// MitreIDs is every constituent signal's own ATT&CK technique IDs,
	// combined — AC1's "kill-chain progression" is the number of
	// DISTINCT tactics these techniques span, not the number of
	// techniques itself (two techniques in the same tactic are one
	// stage, not two).
	MitreIDs []string
	// EntityCriticality is the case's own entity's flagged importance —
	// CriticalityNormal for an entityless case or one with no
	// entity_criticality row at all (AC2's own "ordinary identity").
	EntityCriticality Criticality
	// BaselineDeviation is P3-05's own "tenant baseline deviation"
	// component, not yet implemented (ADR note in
	// docs/architecture/overview.md §3.6) — always 0 until that ticket
	// ships a real per-tenant baseline to deviate from. Kept as a named
	// field, not simply omitted, so Score's Components always reports
	// all five of overview.md's own named factors, explaining why this
	// one is currently inert rather than silently absent.
	BaselineDeviation float64
}

// Result is a case's score, broken into exactly the components that
// sum to it — AC4's own "stored score components reproduce the final
// score exactly".
type Result struct {
	Total      float64
	Components map[string]float64
}

// Score computes a case's score deterministically from Input. Calling
// it twice with an equal Input (down to slice ORDER — MitreIDs and
// Severities are treated as sets/multisets, never order-dependent)
// always returns an equal Result (AC5/T3).
func Score(in Input) Result {
	components := map[string]float64{
		"entityCriticality":    criticalityScore(in.EntityCriticality),
		"signalCount":          float64(in.SignalCount),
		"maxSeverity":          maxSeverityScore(in.Severities),
		"killChainProgression": killChainScore(in.MitreIDs),
		"baselineDeviation":    in.BaselineDeviation,
	}
	var total float64
	for _, v := range components {
		total += v
	}
	return Result{Total: total, Components: components}
}

func criticalityScore(c Criticality) float64 {
	if c == CriticalityHigh {
		return 10
	}
	return 0
}

func maxSeverityScore(severities []Severity) float64 {
	var max float64
	for _, s := range severities {
		if w := severityWeight[s]; w > max {
			max = w
		}
	}
	return max
}

// killChainScore counts the DISTINCT ATT&CK tactics the case's
// techniques span and weights each one beyond the first — a
// single-stage case (every technique in the same tactic, or a case
// with no recognised technique at all) contributes 0, so AC1's "a case
// spanning two kill-chain stages outranks two single-stage cases" is
// just this component being strictly increasing in distinct-tactic
// count, holding every other component equal.
func killChainScore(mitreIDs []string) float64 {
	tactics := distinctTactics(mitreIDs)
	if len(tactics) == 0 {
		return 0
	}
	return float64(len(tactics)-1) * 8
}

func distinctTactics(mitreIDs []string) []string {
	seen := map[string]bool{}
	for _, id := range mitreIDs {
		tech, ok := sentinelattck.Lookup(id)
		if !ok {
			continue
		}
		for _, tactic := range tech.Tactics {
			seen[tactic] = true
		}
	}
	tactics := make([]string, 0, len(seen))
	for t := range seen {
		tactics = append(tactics, t)
	}
	sort.Strings(tactics) // deterministic order, though only the count is ever used
	return tactics
}
