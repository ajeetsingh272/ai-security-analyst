package sigmac

import (
	"math/rand"
	"testing"

	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/detectgen"
)

const (
	testRulesDir    = "../../../../detections/rules"
	testFixturesDir = "../../../../detections/fixtures"
)

// T1: "Generated matcher output equals a reference interpreter on a
// 10,000-event corpus." Compares detectgen.Rules (committed, generated
// by this exact package — see cmd/sigmac-gen) against Evaluate
// (interpret.go) across 10,000 synthetic events per rule, so a bug in
// EITHER the generator's own code-emission logic or in the interpreter
// would show up as a disagreement, not as both independently agreeing
// on their own shared bug.
func TestGeneratedRulesMatchReferenceInterpreter(t *testing.T) {
	rules, errs := ParseCorpus(testRulesDir)
	if len(errs) != 0 {
		t.Fatalf("parsing corpus: %v", errs)
	}
	byID := make(map[string]*Rule, len(rules))
	for _, r := range rules {
		byID[r.ID] = r
	}
	if len(detectgen.Rules) != len(rules) {
		t.Fatalf("detectgen.Rules has %d entries, corpus has %d — regenerate (go run ./cmd/sigmac-gen)", len(detectgen.Rules), len(rules))
	}

	// A pool of values drawn from every rule's own field matches, plus a
	// few values that match nothing — so random events land on real
	// matches often enough to actually exercise each rule's true branch,
	// not just its (otherwise far more probable) false branch.
	var pool []string
	for _, r := range rules {
		for _, sel := range r.Selections {
			for _, fm := range sel.Fields {
				pool = append(pool, fm.Values...)
			}
		}
	}
	pool = append(pool, "", "garbage-value-1", "garbage-value-2", "Failed", "Success")
	paths := []string{"metadata.operation", "unmapped.ResultStatus", "unmapped.UserId", "unmapped.ClientIP", "class_uid", "activity_id"}

	rng := rand.New(rand.NewSource(1)) // fixed seed — deterministic across CI runs
	const eventsPerRule = 10000
	mismatches := 0

	for _, compiled := range detectgen.Rules {
		ref := byID[compiled.ID]
		if ref == nil {
			t.Fatalf("detectgen.Rules has id %q, not present in the parsed corpus", compiled.ID)
		}
		for i := 0; i < eventsPerRule; i++ {
			ev := make(map[string]string, len(paths))
			for _, p := range paths {
				ev[p] = pool[rng.Intn(len(pool))]
			}
			got := compiled.Matches(ev)
			want := Evaluate(ref, ev)
			if got != want {
				mismatches++
				if mismatches <= 5 { // report a handful, not all 10,000
					t.Errorf("rule %q (%s): generated=%v interpreted=%v for event %v", compiled.Title, compiled.ID, got, want, ev)
				}
			}
		}
	}
	if mismatches > 0 {
		t.Fatalf("%d mismatches between generated and interpreted output", mismatches)
	}
}

// T2: "Compilation fails if a rule lacks a MITRE technique id." P2-01's
// own Parse already refuses to produce a Rule without one — this test
// proves that failure propagates through THIS ticket's own pipeline
// (ParseCorpus feeding GenerateSource), not just through Parse in
// isolation (P2-01's own test already covers that).
func TestGenerate_FailsWithoutMitreID(t *testing.T) {
	yaml := []byte(`
title: No MITRE tag
id: no-mitre-id
status: stable
detection:
  selection:
    Operation: 'Foo'
  condition: selection
level: low
`)
	_, err := Parse("no-mitre.yml", yaml)
	if err == nil {
		t.Fatal("expected Parse itself to reject a rule with no MITRE tag before GenerateSource ever sees it")
	}
}

// T3: "Compilation fails if a rule lacks either fixture."
func TestGenerate_FailsWithoutFixture(t *testing.T) {
	rule := &Rule{
		ID:         "rule-with-no-fixture-at-all",
		Slug:       "rule-with-no-fixture-at-all",
		Title:      "No fixture",
		Level:      "low",
		MitreIDs:   []string{"attack.t1078"},
		Selections: map[string]Selection{"selection": {Name: "selection", Fields: []FieldMatch{{SigmaField: "Operation", OCSFPath: "metadata.operation", Modifier: ModEquals, Values: []string{"Foo"}}}}},
		Condition:  SelectionRef{Name: "selection"},
		Engine:     EngineInStream,
	}
	if _, _, err := GenerateSource([]*Rule{rule}, testFixturesDir); err == nil {
		t.Fatal("expected GenerateSource to fail for a rule with no committed fixture")
	}
}

// AC: "Regenerating produces no diff when inputs are unchanged" (T4's
// own CI-level proof is the committed files simply matching what this
// test independently regenerates in memory).
func TestGenerate_RegenerationIsDeterministic(t *testing.T) {
	rules, errs := ParseCorpus(testRulesDir)
	if len(errs) != 0 {
		t.Fatalf("parsing corpus: %v", errs)
	}
	rule1, test1, err := GenerateSource(rules, testFixturesDir)
	if err != nil {
		t.Fatalf("GenerateSource (1st run): %v", err)
	}
	rule2, test2, err := GenerateSource(rules, testFixturesDir)
	if err != nil {
		t.Fatalf("GenerateSource (2nd run): %v", err)
	}
	if string(rule1) != string(rule2) {
		t.Error("regenerating rules.gen.go from the same inputs produced a different result")
	}
	if string(test1) != string(test2) {
		t.Error("regenerating rules.gen_test.go from the same inputs produced a different result")
	}
}
