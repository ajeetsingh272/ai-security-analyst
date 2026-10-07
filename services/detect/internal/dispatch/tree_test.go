package dispatch

import (
	"context"
	"math/rand"
	"testing"

	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/detectgen"
	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/sigmac"
)

const corpusDir = "../../../../detections/rules"

func buildTestTree(t *testing.T) (*Tree, []*sigmac.Rule) {
	t.Helper()
	rules, errs := sigmac.ParseCorpus(corpusDir)
	if len(errs) != 0 {
		t.Fatalf("parsing corpus: %v", errs)
	}
	tree, err := Build(rules, detectgen.Rules, Options{})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	return tree, rules
}

// exhaustiveMatch is T1's own baseline: every compiled rule's predicate,
// called directly, with no class_uid/activity_id narrowing at all — the
// "test against the whole corpus" ADR-0004 says the dispatch tree exists
// specifically to avoid doing per event. It still applies product
// compatibility directly (rather than skipping it) because that check is
// NOT part of any rule's own compiled predicate — Sigma's logsource is
// metadata about which source a rule is FOR, not a selection field a
// predicate evaluates — so without applying it here too, fuzzing
// metadata.product independently of a rule's declared source would make
// this baseline disagree with dispatch over something neither side's
// predicate logic actually governs, rather than over a real dispatch bug.
func exhaustiveMatch(rules []*sigmac.Rule, ev map[string]string) map[string]bool {
	byID := make(map[string]*sigmac.Rule, len(rules))
	for _, r := range rules {
		byID[r.ID] = r
	}
	out := make(map[string]bool, len(detectgen.Rules))
	for _, c := range detectgen.Rules {
		r := byID[c.ID]
		if r.LogSource.Product != "" && r.LogSource.Product != ev["metadata.product"] {
			continue
		}
		if c.Matches(ev) {
			out[c.ID] = true
		}
	}
	return out
}

func matchedIDs(cs []detectgen.CompiledRule) map[string]bool {
	out := make(map[string]bool, len(cs))
	for _, c := range cs {
		out[c.ID] = true
	}
	return out
}

// T1: "Dispatch result is identical to exhaustive evaluation across the
// full fixture corpus" — plus a large synthetic fuzz on top, the same
// "don't just prove it on the three events you hand-picked" discipline
// P2-02's own T1 established.
func TestDispatch_MatchesExhaustiveEvaluation_OnFixtures(t *testing.T) {
	tree, rules := buildTestTree(t)
	ctx := context.Background()

	for _, r := range rules {
		fixture, err := sigmac.LoadFixture("../../../../detections/fixtures", r.Slug)
		if err != nil {
			t.Fatalf("loading fixture for %s: %v", r.Slug, err)
		}
		for _, ev := range []map[string]string{fixture.Positive, fixture.Negative} {
			want := exhaustiveMatch(rules, ev)
			got := matchedIDs(tree.Evaluate(ctx, ev))
			if !equalSets(want, got) {
				t.Errorf("rule %s fixture %v: dispatch=%v exhaustive=%v", r.Slug, ev, got, want)
			}
		}
	}
}

func TestDispatch_MatchesExhaustiveEvaluation_Fuzz(t *testing.T) {
	tree, rules := buildTestTree(t)
	ctx := context.Background()

	var pool []string
	for _, r := range rules {
		for _, sel := range r.Selections {
			for _, fm := range sel.Fields {
				pool = append(pool, fm.Values...)
			}
		}
	}
	pool = append(pool, "", "garbage-1", "garbage-2", "Success", "Failed", "3002", "4009", "1", "m365", "syslog")
	paths := []string{"metadata.operation", "unmapped.ResultStatus", "class_uid", "activity_id", "metadata.product"}

	rng := rand.New(rand.NewSource(7))
	const n = 10000
	mismatches := 0
	for i := 0; i < n; i++ {
		ev := make(map[string]string, len(paths))
		for _, p := range paths {
			ev[p] = pool[rng.Intn(len(pool))]
		}
		want := exhaustiveMatch(rules, ev)
		got := matchedIDs(tree.Evaluate(ctx, ev))
		if !equalSets(want, got) {
			mismatches++
			if mismatches <= 5 {
				t.Errorf("event %v: dispatch=%v exhaustive=%v", ev, got, want)
			}
		}
	}
	if mismatches > 0 {
		t.Fatalf("%d/%d events disagreed between dispatch and exhaustive evaluation", mismatches, n)
	}
}

// T3: "A rule matching on a low-selectivity field is still reached
// correctly" — mfa-method-registration uses Operation|startswith (not an
// equals constraint on any dispatch dimension), so equalsConstraintValues
// returns nil for it on every dimension and it falls back to every
// dimension's wildcard bucket. Proves it is still a candidate AND still
// matches, not just "still a candidate" (a bug that added it to every
// bucket but never called Matches would pass a weaker test).
func TestDispatch_LowSelectivityRuleStillReached(t *testing.T) {
	tree, _ := buildTestTree(t)
	ctx := context.Background()

	ev := map[string]string{"metadata.operation": "Register security info (MFA)", "metadata.product": "m365"}
	matched := tree.Evaluate(ctx, ev)
	found := false
	for _, c := range matched {
		if c.Title == "MFA method registration outside business hours" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected the MFA registration rule (startswith modifier, no dispatch key) to still match, got %v", matchedIDs(matched))
	}

	// Same for mass-file-download, an OR of two selections — its
	// condition isn't a bare SelectionRef at all, so equalsConstraintValues
	// returns nil immediately regardless of the field's own modifier.
	ev2 := map[string]string{"metadata.operation": "FileDeleted", "metadata.product": "m365"}
	matched2 := tree.Evaluate(ctx, ev2)
	found2 := false
	for _, c := range matched2 {
		if c.Title == "Mass file download or deletion within a short window" {
			found2 = true
		}
	}
	if !found2 {
		t.Fatalf("expected the OR-selection mass-file-download rule to still match, got %v", matchedIDs(matched2))
	}
}

func equalSets(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for k := range a {
		if !b[k] {
			return false
		}
	}
	return true
}
