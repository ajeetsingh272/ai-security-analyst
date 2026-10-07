package sigmac

import "time"

// Engine is which of the two detection planes (overview.md §3.5) a parsed
// rule belongs to — the in-stream, stateless, field-indexed decision tree
// (ADR-0004), or the stateful, windowed ClickHouse engine for rules that
// need a join against history (impossible travel, brute force, mass
// download). A rule's condition determines this automatically (see
// condition.go's own aggregation detection) — nothing in the YAML
// declares it explicitly, so a rule author cannot get it wrong by typo.
type Engine int

const (
	EngineInStream Engine = iota
	EngineWindowed
)

func (e Engine) String() string {
	if e == EngineWindowed {
		return "windowed"
	}
	return "in-stream"
}

// Modifier is one of the Sigma field modifiers this ticket's AC1 names:
// contains, startswith, endswith, re (regex), base64. Equals (no pipe
// suffix at all) is the implicit default every Sigma field comparison
// has when no modifier is given.
type Modifier int

const (
	ModEquals Modifier = iota
	ModContains
	ModStartsWith
	ModEndsWith
	ModRegex
	ModBase64
)

func (m Modifier) String() string {
	switch m {
	case ModContains:
		return "contains"
	case ModStartsWith:
		return "startswith"
	case ModEndsWith:
		return "endswith"
	case ModRegex:
		return "re"
	case ModBase64:
		return "base64"
	default:
		return "equals"
	}
}

// FieldMatch is one field's comparison within a Selection — e.g.
// `Operation: FileDownloaded` (ModEquals) or
// `CommandLine|contains: 'powershell'` (ModContains). OCSFPath is the
// result of running the YAML's raw field name (e.g. "CommandLine")
// through fieldmap.go's explicit table — never the raw Sigma name itself,
// so the evaluator built in a later ticket (P2-03/04) never has to know
// any vendor's own field-naming convention.
//
// Values holds every value this field is compared against. Sigma's own
// rule: multiple values for one field are OR'd UNLESS the "all" modifier
// is also present, in which case they're AND'd (AllOf below) — AC1's own
// "all" modifier, which modifies LIST semantics, not the comparison
// itself, which is why it is a bool here rather than a Modifier value.
type FieldMatch struct {
	SigmaField string
	OCSFPath   string
	Modifier   Modifier
	Values     []string
	AllOf      bool
}

// Selection is one named block under `detection:` (e.g. `selection`,
// `selection1`, `filter`) — an implicit AND across every FieldMatch it
// contains, matching Sigma's own semantics for a single mapping.
type Selection struct {
	Name   string
	Fields []FieldMatch
}

// ConditionExpr is the condition DSL's AST (condition.go's parser builds
// it) — a small boolean algebra over selection names, exactly what
// Sigma's own `condition:` string grammar is.
type ConditionExpr interface {
	conditionExpr()
}

// SelectionRef names one selection (or, via OfExpr, a wildcard pattern
// over several) directly — the leaf of the AST.
type SelectionRef struct{ Name string }

// OfExpr is Sigma's "N of pattern" / "all of pattern" form — Count<0
// means "all"; Pattern may contain Sigma's own "*" wildcard (e.g.
// "selection*" matches every selection whose name starts with
// "selection").
type OfExpr struct {
	Count   int // -1 means "all"
	Pattern string
}

type NotExpr struct{ X ConditionExpr }
type AndExpr struct{ X, Y ConditionExpr }
type OrExpr struct{ X, Y ConditionExpr }

func (SelectionRef) conditionExpr() {}
func (OfExpr) conditionExpr()       {}
func (NotExpr) conditionExpr()      {}
func (AndExpr) conditionExpr()      {}
func (OrExpr) conditionExpr()       {}

// Aggregation is the near/aggregation extension AC1 names — Sigma's own
// `condition: selection | count() by Field > N` suffix, which this
// package treats as "route to the windowed engine" rather than
// evaluating itself (that engine is P2-05's own ticket). Parsed here only
// far enough to classify the rule and record what the windowed engine
// will need; condition.go's own doc comment explains the exact pipe
// grammar this package accepts.
type Aggregation struct {
	GroupBy    []string
	Op         string // "count" is the only aggregation op this subset supports
	Comparator string // one of "<", "<=", ">", ">=", "=="
	Threshold  int
	Window     time.Duration
}

// Rule is this package's entire deliverable: one Sigma YAML file, fully
// parsed and validated, ready for P2-02's code generator (in-stream
// rules) or P2-05's windowed query generator (windowed rules) to consume.
// Never constructed directly outside this package — Parse/ParseFile are
// the only entry points, so every Rule in existence has already passed
// every AC this ticket requires.
type Rule struct {
	ID          string
	Title       string
	Level       string
	MitreIDs    []string
	LogSource   LogSource
	Selections  map[string]Selection
	Condition   ConditionExpr
	Engine      Engine
	Aggregation *Aggregation
	SpecVersion string
	SourceFile  string
	// Slug is SourceFile's basename with its extension stripped — e.g.
	// "anonymous-proxy-signin" for detections/rules/anonymous-proxy-signin.yml.
	// This, not ID (the YAML's own internal `id:` UUID), is what fixture
	// filenames and generated identifiers are keyed by: CONTRIBUTING.md
	// and scripts/validate-detections.sh already document and enforce
	// "<rule file name>.positive.json"/".negative.json" as the fixture
	// convention, and this field exists so sigmac doesn't invent a
	// second, UUID-keyed convention alongside it.
	Slug string
}

type LogSource struct {
	Category string
	Product  string
	Service  string
}
