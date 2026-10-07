// Package attck is P2-07: validating every rule's own MITRE tag
// against the real, published ATT&CK matrix (AC1/AC2) and building the
// coverage report and ATT&CK Navigator layer stakeholders use to see
// gaps rather than assume them (AC3/AC4).
//
// The pinned technique catalogue itself (Technique, All, Lookup,
// NormalizeID, CatalogueVersion) moved to go/sentinelattck in P3-04,
// when services/correlate needed the same technique→tactics lookup for
// kill-chain-stage scoring — Go's internal/ visibility rule meant this
// package could never be imported from another module, so the
// catalogue became a standalone, shared module rather than a second,
// drifting copy of the pinned data. This file re-exports that module's
// symbols under their original names, so every other file in this
// package (coverage.go, navigator.go, validate.go) and their tests
// needed no changes at all.
package attck

import "github.com/ajeetsingh272/ai-security-analyst/go/sentinelattck"

// CatalogueVersion is the pinned attack-stix-data release tag the
// catalogue was extracted from.
const CatalogueVersion = sentinelattck.CatalogueVersion

// Technique is one ATT&CK technique or sub-technique.
type Technique = sentinelattck.Technique

// All returns every technique in the pinned catalogue, including
// deprecated and revoked ones.
func All() []Technique { return sentinelattck.All() }

// Lookup finds a technique by its ATT&CK ID ("T1110.003" or "T1110" —
// case-insensitive, and tolerant of Sigma's own "attack." tag prefix).
func Lookup(id string) (Technique, bool) { return sentinelattck.Lookup(id) }

// NormalizeID turns a Sigma tag or a bare, differently-cased ATT&CK ID
// into the catalogue's own canonical form ("T1110.003").
func NormalizeID(id string) string { return sentinelattck.NormalizeID(id) }
