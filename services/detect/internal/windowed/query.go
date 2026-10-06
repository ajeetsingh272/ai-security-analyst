// Package windowed is P2-05: the stateful detection engine for Sigma rules
// whose condition carries a `| count() by ... within ...` aggregation
// (sigmac.EngineWindowed) — a join against history that the in-stream
// dispatch tree (P2-03/P2-04) structurally cannot evaluate per event.
// Each such rule compiles to one parameterized ClickHouse query, run on a
// schedule (scheduler.go), producing the same go/sentinelsignal.Signal
// shape the in-stream worker does.
package windowed

import (
	"fmt"
	"strings"

	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/sigmac"
)

// CompiledQuery is one windowed rule's query, parameterized and ready to
// run repeatedly — built once at startup (BuildQuery), then Args() is
// called fresh on every scheduled tick with that tick's own window bounds.
// Every value this type's SQL ever compares against — a rule's own
// literal field value, a map key, the aggregation threshold, the window
// bounds — is a bind argument; none is ever formatted into the SQL
// string itself (T3: "resists an injection attempt"), the one property
// this type exists to guarantee regardless of who eventually controls any
// of those values.
type CompiledQuery struct {
	Rule *sigmac.Rule
	SQL  string

	// preWindowArgs/postWindowArgs are exactly the bind args whose `?`
	// placeholders appear, respectively, before and after the two window-
	// bound placeholders in SQL's own text — clickhouse-go binds `?`
	// strictly positionally, so Args' own ordering must mirror SQL's
	// layout exactly: SELECT's own group-key/agg-expr placeholders come
	// first, then WHERE's "time >= ? AND time < ?", then the condition's
	// and HAVING's placeholders.
	preWindowArgs  []any
	postWindowArgs []any
}

// Args returns this query's bind arguments for one execution covering
// [windowStart, windowEnd) — the only two values that change between
// ticks; everything else was fixed when the rule was compiled.
func (q *CompiledQuery) Args(windowStart, windowEnd any) []any {
	args := make([]any, 0, len(q.preWindowArgs)+2+len(q.postWindowArgs))
	args = append(args, q.preWindowArgs...)
	args = append(args, windowStart, windowEnd)
	args = append(args, q.postWindowArgs...)
	return args
}

// BuildQuery compiles a windowed rule's selections/condition/aggregation
// into one parameterized SELECT. Fails loudly (AC4/T4's own "a field
// mapping failure is an error, not a silent no-match" doctrine, applied
// here to query compilation) rather than guess at anything this engine
// does not yet support — a windowed rule using a modifier other than
// equals, the "all" modifier, an N-of-pattern condition, or a group-by
// field not in fieldmap.go's table, is rejected at build time, not
// silently miscompiled.
func BuildQuery(r *sigmac.Rule) (*CompiledQuery, error) {
	if r.Engine != sigmac.EngineWindowed {
		return nil, fmt.Errorf("windowed: rule %s is not a windowed rule", r.ID)
	}
	if r.Aggregation == nil {
		return nil, fmt.Errorf("windowed: rule %s has Engine=windowed but no Aggregation", r.ID)
	}

	groupKeySQL, groupKeyArgs, aggExprSQL, aggArgs, err := groupKeyAndAggExpr(r.Aggregation)
	if err != nil {
		return nil, fmt.Errorf("windowed: rule %s: %w", r.ID, err)
	}
	condSQL, condArgs, err := conditionSQL(r.Condition, r.Selections)
	if err != nil {
		return nil, fmt.Errorf("windowed: rule %s: %w", r.ID, err)
	}
	comparator, err := sqlComparator(r.Aggregation.Comparator)
	if err != nil {
		return nil, fmt.Errorf("windowed: rule %s: %w", r.ID, err)
	}

	sql := fmt.Sprintf(`SELECT tenant_id, %s AS group_key, %s AS agg_value, groupArray(event_id) AS event_ids
FROM sentinel.events
WHERE time >= ? AND time < ? AND %s
GROUP BY tenant_id, group_key
HAVING agg_value %s ?`, groupKeySQL, aggExprSQL, condSQL, comparator)

	pre := append(append([]any{}, groupKeyArgs...), aggArgs...)
	post := append(append([]any{}, condArgs...), r.Aggregation.Threshold)

	return &CompiledQuery{Rule: r, SQL: sql, preWindowArgs: pre, postWindowArgs: post}, nil
}

// columnExpr returns the ClickHouse expression for an OCSF path, plus the
// map-key bind arg it needs (nil for a bare typed column) — "metadata[?]"
// or "unmapped[?]" rather than a quoted literal key, so this package never
// formats a Go string directly into SQL text at all, not even one that
// happens to originate from a reviewed rule YAML rather than tenant input.
func columnExpr(ocsfPath string) (exprSQL string, keyArg any, err error) {
	switch ocsfPath {
	case "tenant_id", "class_uid", "category_uid", "activity_id", "severity_id":
		return ocsfPath, nil, nil
	}
	if key, ok := strings.CutPrefix(ocsfPath, "metadata."); ok {
		return "metadata[?]", key, nil
	}
	if key, ok := strings.CutPrefix(ocsfPath, "unmapped."); ok {
		return "unmapped[?]", key, nil
	}
	return "", nil, fmt.Errorf("no ClickHouse column for OCSF path %q", ocsfPath)
}

// fieldMatchSQL compiles one FieldMatch to a SQL boolean fragment plus its
// bind args, in the exact order its own `?`s appear.
func fieldMatchSQL(fm sigmac.FieldMatch) (sql string, args []any, err error) {
	if fm.Modifier != sigmac.ModEquals {
		return "", nil, fmt.Errorf("field %q uses modifier %q, which this engine does not support yet (equals only)", fm.SigmaField, fm.Modifier)
	}
	if fm.AllOf {
		return "", nil, fmt.Errorf("field %q uses the \"all\" modifier, which this engine does not support (equals can never hold more than one literal value for the same field at once)", fm.SigmaField)
	}
	if len(fm.Values) == 0 {
		return "", nil, fmt.Errorf("field %q has no comparison values", fm.SigmaField)
	}

	exprSQL, keyArg, err := columnExpr(fm.OCSFPath)
	if err != nil {
		return "", nil, fmt.Errorf("field %q: %w", fm.SigmaField, err)
	}

	var parts []string
	for _, v := range fm.Values {
		parts = append(parts, exprSQL+" = ?")
		if keyArg != nil {
			args = append(args, keyArg, v)
		} else {
			args = append(args, v)
		}
	}
	if len(parts) == 1 {
		return parts[0], args, nil
	}
	return "(" + strings.Join(parts, " OR ") + ")", args, nil
}

// selectionSQL is an implicit AND across every field in the selection —
// Sigma's own semantics for one mapping block, the same rule
// interpret.go's evaluateSelection applies in Go.
func selectionSQL(sel sigmac.Selection) (string, []any, error) {
	if len(sel.Fields) == 0 {
		return "", nil, fmt.Errorf("selection %q has no fields", sel.Name)
	}
	var parts []string
	var args []any
	for _, fm := range sel.Fields {
		s, a, err := fieldMatchSQL(fm)
		if err != nil {
			return "", nil, fmt.Errorf("selection %q: %w", sel.Name, err)
		}
		parts = append(parts, s)
		args = append(args, a...)
	}
	return "(" + strings.Join(parts, " AND ") + ")", args, nil
}

// conditionSQL mirrors interpret.go's evaluateCondition recursion exactly,
// emitting SQL instead of evaluating in Go — OfExpr ("N of pattern") is
// the one case deliberately not supported: no rule in today's corpus
// needs it for a windowed condition, and a SQL translation of "N of these
// M named selections" is a correctness-sensitive enough shape to earn its
// own ticket rather than a guess bundled into this one.
func conditionSQL(expr sigmac.ConditionExpr, selections map[string]sigmac.Selection) (string, []any, error) {
	switch e := expr.(type) {
	case sigmac.SelectionRef:
		sel, ok := selections[e.Name]
		if !ok {
			return "", nil, fmt.Errorf("condition references unknown selection %q", e.Name)
		}
		return selectionSQL(sel)
	case sigmac.NotExpr:
		s, a, err := conditionSQL(e.X, selections)
		if err != nil {
			return "", nil, err
		}
		return "NOT " + s, a, nil
	case sigmac.AndExpr:
		sx, ax, err := conditionSQL(e.X, selections)
		if err != nil {
			return "", nil, err
		}
		sy, ay, err := conditionSQL(e.Y, selections)
		if err != nil {
			return "", nil, err
		}
		return "(" + sx + " AND " + sy + ")", append(ax, ay...), nil
	case sigmac.OrExpr:
		sx, ax, err := conditionSQL(e.X, selections)
		if err != nil {
			return "", nil, err
		}
		sy, ay, err := conditionSQL(e.Y, selections)
		if err != nil {
			return "", nil, err
		}
		return "(" + sx + " OR " + sy + ")", append(ax, ay...), nil
	case sigmac.OfExpr:
		return "", nil, fmt.Errorf("%q-of-pattern conditions are not supported by the windowed engine yet", e.Pattern)
	default:
		return "", nil, fmt.Errorf("unsupported condition type %T", expr)
	}
}

// groupKeyAndAggExpr translates an Aggregation into its GROUP BY key
// expression and its aggregate expression.
//
// Sigma's own "count() by A within W" grammar, as this parser subset
// records it (sigmac.Aggregation.GroupBy), does not distinguish "group by
// A, count rows" from "group by A, count DISTINCT B" — condition.go just
// collects every field named after "by" into one flat list. This is where
// that ambiguity is resolved, not an answer the IR already gave:
// exactly one GroupBy field means "group by it, count matching rows"
// (mass-mailbox-download.yml, mass-file-download.yml); more than one
// means the LAST field is counted distinctly per group of the rest
// (impossible-travel.yml's own stated intent — "more distinct source IPs
// for one user... than is physically plausible" — group by UserId, count
// DISTINCT ClientIP, not "more than one row sharing the exact (UserId,
// ClientIP) pair", which a literal multi-column GROUP BY would mean).
func groupKeyAndAggExpr(agg *sigmac.Aggregation) (groupKeySQL string, groupKeyArgs []any, aggExprSQL string, aggArgs []any, err error) {
	if agg.Op != "count" {
		return "", nil, "", nil, fmt.Errorf("aggregation op %q is not supported (only \"count\")", agg.Op)
	}
	if len(agg.GroupBy) == 0 {
		return "", nil, "", nil, fmt.Errorf("aggregation has no group-by fields")
	}

	mapped := make([]string, len(agg.GroupBy))
	for i, f := range agg.GroupBy {
		path, ok := sigmac.MapField(f)
		if !ok {
			return "", nil, "", nil, fmt.Errorf("group-by field %q is not in the field mapping table (fieldmap.go)", f)
		}
		mapped[i] = path
	}

	groupFields := mapped
	var countField string
	if len(mapped) > 1 {
		groupFields = mapped[:len(mapped)-1]
		countField = mapped[len(mapped)-1]
	}
	// The SQL template below aliases the group key as one column
	// (`... AS group_key`), which only works for exactly one grouping
	// field — true for every rule in today's corpus (GroupBy has at most
	// 2 entries: a group field and a counted field). A genuine composite
	// group key (3+ GroupBy entries) needs its own SQL shape and is
	// rejected rather than silently emitting a query that groups wrong.
	if len(groupFields) != 1 {
		return "", nil, "", nil, fmt.Errorf("a composite group-by key (%d fields) is not supported yet", len(groupFields))
	}

	groupKeySQL, keyArg, err := columnExpr(groupFields[0])
	if err != nil {
		return "", nil, "", nil, err
	}
	if keyArg != nil {
		groupKeyArgs = append(groupKeyArgs, keyArg)
	}

	if countField != "" {
		expr, keyArg, err := columnExpr(countField)
		if err != nil {
			return "", nil, "", nil, err
		}
		aggExprSQL = "count(DISTINCT " + expr + ")"
		if keyArg != nil {
			aggArgs = append(aggArgs, keyArg)
		}
	} else {
		aggExprSQL = "count()"
	}
	return groupKeySQL, groupKeyArgs, aggExprSQL, aggArgs, nil
}

func sqlComparator(c string) (string, error) {
	switch c {
	case "<", "<=", ">", ">=":
		return c, nil
	case "==":
		return "=", nil
	default:
		return "", fmt.Errorf("unsupported comparator %q", c)
	}
}
