// Package customerrules is P7-10/ADR-0012's own evaluation path for
// tenant-authored detection rules — entirely separate from the compiled
// corpus (ADR-0004) and from the platform-only hotfix path (P2-12),
// never bolted onto either. See ADR-0012 for the full design and the
// numbers below's own justification.
package customerrules

import (
	"fmt"

	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/sigmac"
)

// These limits ARE the primary safety mechanism (ADR-0012 §1), not a
// courtesy check — a rule rejected here never runs against a real
// event at all. See ADR-0012's own decision table for why each number
// is what it is.
const (
	maxSelections      = 20
	maxFieldsPerSelect = 10
	maxValuesPerField  = 10
	maxConditionDepth  = 8
	maxRegexLength     = 200
	maxRuleYAMLBytes   = 8 * 1024
)

// ValidationError is a rejected rule's reason, distinct from an
// ordinary error so a caller (the activator, the API) can surface the
// specific limit a submission failed, rather than a bare parse error.
type ValidationError struct {
	msg string
}

func (e *ValidationError) Error() string { return e.msg }

func rejectf(format string, args ...any) error {
	return &ValidationError{msg: fmt.Sprintf(format, args...)}
}

// Validate parses ruleYAML through the exact same sigmac.Parse every
// platform rule goes through, then applies the restricted-dialect
// limits ADR-0012 §1 names. A rule that fails ANY of these is rejected
// before sigmac.Evaluate ever sees it — this function, not a runtime
// watchdog, is what makes "cannot run unboundedly" true.
func Validate(ruleID, ruleYAML string) (*sigmac.Rule, error) {
	if len(ruleYAML) > maxRuleYAMLBytes {
		return nil, rejectf("rule definition is %d bytes, over the %d byte limit", len(ruleYAML), maxRuleYAMLBytes)
	}

	r, err := sigmac.Parse(ruleID, []byte(ruleYAML))
	if err != nil {
		return nil, err
	}

	// ADR-0012 §1: in-stream only. A windowed rule's query spans every
	// tenant's rows in one scan today (windowed.BuildQuery's own
	// GROUP BY tenant_id, no per-tenant WHERE) — safe only because
	// every windowed rule is currently platform-reviewed. Scoping
	// that query per-tenant is real, separable future work (ADR-0012's
	// own "Revisit when"), not something this validator assumes away.
	if r.Engine != sigmac.EngineInStream || r.Aggregation != nil {
		return nil, rejectf("customer rules may not use windowed/aggregation conditions (e.g. 'count() by ... within ...') — in-stream conditions only")
	}

	if len(r.Selections) > maxSelections {
		return nil, rejectf("rule has %d selections, over the %d limit", len(r.Selections), maxSelections)
	}
	for name, sel := range r.Selections {
		if len(sel.Fields) > maxFieldsPerSelect {
			return nil, rejectf("selection %q has %d fields, over the %d limit", name, len(sel.Fields), maxFieldsPerSelect)
		}
		for _, fm := range sel.Fields {
			if len(fm.Values) > maxValuesPerField {
				return nil, rejectf("field %q in selection %q has %d values, over the %d limit", fm.SigmaField, name, len(fm.Values), maxValuesPerField)
			}
			if fm.Modifier == sigmac.ModRegex {
				for _, v := range fm.Values {
					if len(v) > maxRegexLength {
						return nil, rejectf("regex pattern on field %q in selection %q is %d characters, over the %d limit", fm.SigmaField, name, len(v), maxRegexLength)
					}
				}
			}
		}
	}

	if depth := conditionDepth(r.Condition); depth > maxConditionDepth {
		return nil, rejectf("condition expression is %d levels deep, over the %d limit", depth, maxConditionDepth)
	}

	return r, nil
}

// conditionDepth walks the boolean AST (ir.go's ConditionExpr) and
// returns its deepest nesting — a SelectionRef/OfExpr leaf is depth 1,
// matching evaluateCondition's own one-Go-stack-frame-per-level
// recursion in interpret.go, which is the actual resource this limit
// bounds.
func conditionDepth(expr sigmac.ConditionExpr) int {
	switch e := expr.(type) {
	case sigmac.NotExpr:
		return 1 + conditionDepth(e.X)
	case sigmac.AndExpr:
		return 1 + max(conditionDepth(e.X), conditionDepth(e.Y))
	case sigmac.OrExpr:
		return 1 + max(conditionDepth(e.X), conditionDepth(e.Y))
	default: // SelectionRef, OfExpr
		return 1
	}
}
