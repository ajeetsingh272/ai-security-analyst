// Package sigmac is P2-01: a parser from the Sigma rule specification's
// YAML surface into a typed intermediate representation (IR, see ir.go),
// and P2-02's own home for the Go code generator that will later compile
// that IR to a decision tree (ADR-0004 — this package is the literal
// location that ADR names).
//
// This package deliberately supports a SUBSET of the real Sigma
// specification — exactly the constructs ADR-0004 and this ticket's own
// acceptance criteria name (selection, condition, the contains/startswith/
// endswith/re/all/base64 modifiers, and a near/aggregation extension for
// routing to the windowed engine). Anything outside that subset is a
// build-time error naming the rule and the construct (AC2), never a
// silent mis-evaluation — ADR-0004's whole point is that a bad rule is
// caught by CI, not by a pager.
package sigmac

// SpecVersion is the pinned Sigma specification version this parser
// implements (ADR-0004's own risk mitigation: "Compiler pins a Sigma spec
// version; upgrades are deliberate, with the full corpus re-tested").
// Sigma's specification itself doesn't carry a single canonical version
// number the way, say, OpenAPI does — SigmaHQ/sigma-specification's own
// releases are what this string tracks. Bumping it is a deliberate,
// reviewed change, never incidental to an unrelated rule edit.
const SpecVersion = "sigma-spec-2024-07"

// rawRule mirrors a Sigma rule YAML file's top-level shape closely enough
// to unmarshal it — not a general-purpose Sigma type, just this package's
// own parsing input. detection is kept as a raw map so condition's
// grammar (parsed separately, condition.go) and the various selectionN
// keys can be told apart without a second schema.
type rawRule struct {
	Title       string         `yaml:"title"`
	ID          string         `yaml:"id"`
	Status      string         `yaml:"status"`
	Description string         `yaml:"description"`
	Level       string         `yaml:"level"`
	Tags        []string       `yaml:"tags"`
	LogSource   rawLogSource   `yaml:"logsource"`
	Detection   map[string]any `yaml:"detection"`
	// OwnerDescription is P2-06's own addition — AC4: "every rule has a
	// plain-English description written for a non-technical owner",
	// deliberately a SEPARATE field from Description above, which stays
	// the engineer's own rationale (why this is worth detecting, which
	// later ticket owns a gap, etc. — several existing rules' own
	// Description already reference ADR numbers and internal component
	// names, exactly the jargon AC4 exists to keep OUT of what an owner
	// reads).
	OwnerDescription string `yaml:"owner_description"`
}

type rawLogSource struct {
	Category string `yaml:"category"`
	Product  string `yaml:"product"`
	Service  string `yaml:"service"`
}
