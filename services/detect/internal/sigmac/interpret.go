package sigmac

import (
	"encoding/base64"
	"regexp"
	"strings"
)

// Evaluate is the reference interpreter — the slow, obviously-correct
// baseline P2-02's own T1 cross-checks the generated (compiled) predicate
// against on a 10,000-event corpus. It walks Rule's data at runtime,
// exactly the "parse the YAML into a generic matcher and interpret it
// per event" approach ADR-0004 rejected for production use on cost
// grounds — which is precisely why it is the right reference to compile
// against: if it disagrees with the generated code, the generator has a
// bug, not the other way round.
//
// Deliberately ignores Aggregation entirely: a windowed rule's boolean
// condition still identifies "what counts" (the candidate-event
// prefilter P2-05's windowed engine will reuse), which is all this
// function or the generated predicates it's checked against claim to
// evaluate — the count/window/threshold logic is P2-05's own ticket.
func Evaluate(r *Rule, ev Event) bool {
	selResults := make(map[string]bool, len(r.Selections))
	for name, sel := range r.Selections {
		selResults[name] = evaluateSelection(sel, ev)
	}
	return evaluateCondition(r.Condition, selResults, r.Selections)
}

func evaluateCondition(expr ConditionExpr, selResults map[string]bool, selections map[string]Selection) bool {
	switch e := expr.(type) {
	case SelectionRef:
		return selResults[e.Name]
	case OfExpr:
		names := matchSelectionPattern(e.Pattern, selections)
		count := 0
		for _, n := range names {
			if selResults[n] {
				count++
			}
		}
		if e.Count < 0 { // "all of"
			return count == len(names)
		}
		return count >= e.Count
	case NotExpr:
		return !evaluateCondition(e.X, selResults, selections)
	case AndExpr:
		return evaluateCondition(e.X, selResults, selections) && evaluateCondition(e.Y, selResults, selections)
	case OrExpr:
		return evaluateCondition(e.X, selResults, selections) || evaluateCondition(e.Y, selResults, selections)
	default:
		return false
	}
}

// evaluateSelection is an implicit AND across every field in the
// selection — Sigma's own semantics for one mapping block.
func evaluateSelection(sel Selection, ev Event) bool {
	for _, fm := range sel.Fields {
		if !evaluateFieldMatch(fm, ev) {
			return false
		}
	}
	return true
}

// evaluateFieldMatch applies one field's modifier against the event's
// value at fm.OCSFPath, OR'd across fm.Values unless AllOf requests AND
// (ir.go's own doc comment on why "all" is a bool here, not a Modifier).
// A missing key reads as Go's own map zero value (""), matching every
// modifier's ordinary string semantics rather than a special "absent"
// case — exactly what the generated code (codegen.go) does too, which is
// the parity T1 checks.
func evaluateFieldMatch(fm FieldMatch, ev Event) bool {
	actual := ev[fm.OCSFPath]
	if fm.AllOf {
		for _, want := range fm.Values {
			if !matchOne(fm.Modifier, actual, want) {
				return false
			}
		}
		return len(fm.Values) > 0
	}
	for _, want := range fm.Values {
		if matchOne(fm.Modifier, actual, want) {
			return true
		}
	}
	return false
}

func matchOne(mod Modifier, actual, want string) bool {
	switch mod {
	case ModContains:
		return strings.Contains(actual, want)
	case ModStartsWith:
		return strings.HasPrefix(actual, want)
	case ModEndsWith:
		return strings.HasSuffix(actual, want)
	case ModRegex:
		re, err := regexp.Compile(want)
		if err != nil {
			return false
		}
		return re.MatchString(actual)
	case ModBase64:
		decoded, err := base64.StdEncoding.DecodeString(want)
		if err != nil {
			return false
		}
		return actual == string(decoded)
	default: // ModEquals
		return actual == want
	}
}
