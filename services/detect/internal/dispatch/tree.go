// Package dispatch is P2-03: a field-indexed candidate selector, so an
// event is tested against a handful of rules rather than the whole
// corpus (ADR-0004's own "4.5 million rule evaluations per second"
// problem at naive 150-rule/30k-EPS scale).
//
// Dispatch only ever NARROWS which compiled predicates get called — it
// never substitutes for one. A rule's predicate (P2-02's own compiled
// Go function) is still the sole source of truth for whether it
// actually matches; this package's entire correctness obligation is
// "never excludes a rule that could have matched", which is what makes
// AC's "evaluation result is provably identical to exhaustive
// evaluation" (T1) a property of the INDEX, not of yet another
// hand-written matcher that could itself disagree with the real one.
package dispatch

import (
	"context"

	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/detectgen"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/sigmac"
	"go.opentelemetry.io/otel/metric"
)

// wildcardKey is the bucket a rule falls into, on a given dimension,
// when this package cannot PROVE a single-value constraint on that
// dimension from the rule's own data — correctness over cleverness: an
// unindexable rule is checked for every event on that dimension rather
// than risk silently excluding it from events it could actually match.
const wildcardKey = "\x00wildcard"

// Tree is the built index — construct once via Build, query many times
// via Candidates. Not safe for concurrent Build calls, but Candidates
// itself only reads immutable state built once, so concurrent dispatch
// from multiple goroutines (P2-04's worker pool) is safe.
type Tree struct {
	rules []detectgen.CompiledRule

	byClassUID   map[string][]int
	byActivityID map[string][]int
	byProduct    map[string][]int

	// candidateCount, if non-nil, records how many candidates survived
	// the three-way intersection for each Candidates call — AC's own
	// "candidate rule count per event is exported as a metric". Optional
	// and nil-safe, the same pattern every other Go service in this repo
	// uses for its own metrics (e.g. go/sentinelconnector.Scheduler).
	candidateCount metric.Int64Histogram
}

// Options configures Build. CandidateCount is optional.
type Options struct {
	CandidateCount metric.Int64Histogram
}

// Build indexes every rule in rules (the parsed IR, P2-01) against its
// matching compiled predicate in compiled (P2-02) by ID. AC's "adding a
// rule does not require hand-editing the dispatch tree" is true by
// construction: this function derives every index entry from the rules'
// own data, so a new rule is indexed correctly the moment it is parsed
// and compiled — no second place to update.
func Build(rules []*sigmac.Rule, compiled []detectgen.CompiledRule, opts Options) (*Tree, error) {
	compiledByID := make(map[string]detectgen.CompiledRule, len(compiled))
	for _, c := range compiled {
		compiledByID[c.ID] = c
	}

	t := &Tree{
		byClassUID:     make(map[string][]int),
		byActivityID:   make(map[string][]int),
		byProduct:      make(map[string][]int),
		candidateCount: opts.CandidateCount,
	}

	for _, r := range rules {
		c, ok := compiledByID[r.ID]
		if !ok {
			continue // a rule P2-02 chose not to compile (none today) — not this package's concern.
		}
		idx := len(t.rules)
		t.rules = append(t.rules, c)

		addToIndex(t.byClassUID, idx, equalsConstraintValues(r, "class_uid"))
		addToIndex(t.byActivityID, idx, equalsConstraintValues(r, "activity_id"))
		// metadata.product is never inferred from a selection's own field
		// constraints — unlike class_uid/activity_id, EVERY rule already
		// declares its log source's product unconditionally in its YAML
		// (logsource.product), which is a precise, always-available
		// dispatch key that needs no conservative fallback at all.
		product := r.LogSource.Product
		if product == "" {
			product = wildcardKey
		}
		t.byProduct[product] = append(t.byProduct[product], idx)
	}
	return t, nil
}

// Candidates returns every compiled rule that MIGHT match ev — the
// three-way intersection of each dimension's exact-value bucket unioned
// with that dimension's wildcard bucket. ev is read only at
// "class_uid", "activity_id" and "metadata.product" — exactly ADR-0004's
// own three named dispatch fields.
func (t *Tree) Candidates(ctx context.Context, ev map[string]string) []detectgen.CompiledRule {
	classSet := union(t.byClassUID[ev["class_uid"]], t.byClassUID[wildcardKey])
	activitySet := union(t.byActivityID[ev["activity_id"]], t.byActivityID[wildcardKey])
	productSet := union(t.byProduct[ev["metadata.product"]], t.byProduct[wildcardKey])

	idxs := intersect(intersect(classSet, activitySet), productSet)

	if t.candidateCount != nil {
		t.candidateCount.Record(ctx, int64(len(idxs)))
	}

	out := make([]detectgen.CompiledRule, len(idxs))
	for i, idx := range idxs {
		out[i] = t.rules[idx]
	}
	return out
}

// Evaluate runs Candidates then calls Matches on each — the one call a
// consumer (P2-04's worker) actually needs; kept separate from
// Candidates so T1/T2's own tests can inspect the candidate set itself
// without also needing real events that satisfy every rule's predicate.
func (t *Tree) Evaluate(ctx context.Context, ev map[string]string) []detectgen.CompiledRule {
	var matched []detectgen.CompiledRule
	for _, c := range t.Candidates(ctx, ev) {
		if c.Matches(ev) {
			matched = append(matched, c)
		}
	}
	return matched
}

// addToIndex registers idx under every value in values, or under
// wildcardKey when values is empty — the fallback equalsConstraintValues
// itself deliberately doesn't apply, since "no provable constraint" and
// "this index" are two different callers' concerns. Without this
// fallback, a rule with no constraint on a dimension would be added
// under NO key at all on that dimension (not even wildcard), which is
// the exact bug T1's own fuzz test caught: every such rule silently
// vanished from every dispatch result, not just failed to be narrowed.
func addToIndex(index map[string][]int, idx int, values []string) {
	if len(values) == 0 {
		index[wildcardKey] = append(index[wildcardKey], idx)
		return
	}
	for _, v := range values {
		index[v] = append(index[v], idx)
	}
}

// union is called with exactly (exact-match bucket, wildcard bucket) on
// every Candidates call — T2's own p99 budget is tight enough that the
// common case (the wildcard bucket is empty, because most rules in a
// real corpus DO constrain at least one of these three fields) must not
// pay for a map allocation it doesn't need. Falls back to an O(n*m)
// scan — no allocation at all — for the genuinely small sets a single
// dispatch bucket actually holds; a hash-based de-dup would only pay
// for itself at set sizes this package never sees per bucket.
func union(a, b []int) []int {
	if len(b) == 0 {
		return a
	}
	if len(a) == 0 {
		return b
	}
	out := make([]int, 0, len(a)+len(b))
	out = append(out, a...)
	for _, v := range b {
		dup := false
		for _, existing := range a {
			if existing == v {
				dup = true
				break
			}
		}
		if !dup {
			out = append(out, v)
		}
	}
	return out
}

// intersect: same reasoning as union — small sets, no allocation beyond
// the (worst-case len(a)-sized) result slice itself.
func intersect(a, b []int) []int {
	if len(a) == 0 || len(b) == 0 {
		return nil
	}
	out := make([]int, 0, len(a))
	for _, v := range a {
		for _, w := range b {
			if v == w {
				out = append(out, v)
				break
			}
		}
	}
	return out
}

// equalsConstraintValues returns the set of values that WOULD make
// ocsfPath's own equality check true for rule — ONLY when that can be
// proven safe to use as a dispatch key: the rule's condition is a single
// SelectionRef (no and/or/not/of-pattern composition to reason about —
// an OR'd selection, for instance, could still be true even when this
// ONE field doesn't match, so a condition more complex than a bare
// SelectionRef can never be safely narrowed this way), and that
// selection has (among however many fields it ANDs together) one whose
// OCSFPath is ocsfPath, with an equals modifier and not AllOf.
//
// Scanning every field rather than requiring exactly one is deliberate:
// a selection ANDs its fields together, so a rule constraining BOTH
// class_uid AND activity_id in the same selection is still perfectly
// safe to index on EITHER one alone — if that one field doesn't match,
// the AND makes the whole selection false regardless of the other
// fields, which is exactly what makes it sound to use as a dispatch key
// (a necessary condition, not claimed to be sufficient on its own).
// AllOf is excluded for a different reason: it means every one of
// Values must hold simultaneously against a single event field, which
// cannot be true for more than one of them at once — using them all as
// alternative ("OR'd") dispatch keys would be wrong.
//
// A rule this function can't prove a constraint for returns nil, which
// is why callers add wildcardKey as this dimension's constraint instead —
// AC's own "a rule matching on a low-selectivity field is still reached
// correctly" (T3) is this fallback, exercised directly: a rule with a
// `contains` modifier, or an OR of two selections, is NOT lost — it is
// simply checked on every event on this dimension instead of being
// narrowed, same as if the dispatch tree didn't exist for it.
func equalsConstraintValues(r *sigmac.Rule, ocsfPath string) []string {
	ref, ok := r.Condition.(sigmac.SelectionRef)
	if !ok {
		return nil
	}
	sel, ok := r.Selections[ref.Name]
	if !ok {
		return nil
	}
	for _, fm := range sel.Fields {
		if fm.OCSFPath == ocsfPath && fm.Modifier == sigmac.ModEquals && !fm.AllOf {
			return fm.Values
		}
	}
	return nil
}
