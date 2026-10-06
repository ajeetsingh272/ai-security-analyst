package attck

import "testing"

// T2: coverage report counts match the rule corpus.
func TestBuildCoverage_CountsMatchCorpus(t *testing.T) {
	rules := []Rule{
		fakeRule{title: "rule A", tags: []string{"attack.t1110.003"}},
		fakeRule{title: "rule B", tags: []string{"attack.t1098.001"}},
		// Same technique as rule A, covered by two rules — must still
		// count as ONE covered technique, not two.
		fakeRule{title: "rule C", tags: []string{"attack.t1110.003"}},
	}
	report := BuildCoverage(rules)

	if got := report.CoveredCount(); got != 2 {
		t.Fatalf("CoveredCount() = %d, want 2 (T1110.003 and T1098.001)", got)
	}

	var t1110003, t1098001 TechniqueCoverage
	found := 0
	for _, tc := range report.Techniques {
		switch tc.ID {
		case "T1110.003":
			t1110003 = tc
			found++
		case "T1098.001":
			t1098001 = tc
			found++
		}
	}
	if found != 2 {
		t.Fatalf("expected both T1110.003 and T1098.001 to appear in the report")
	}
	if !t1110003.Covered || len(t1110003.RuleTitles) != 2 {
		t.Errorf("T1110.003 = %+v, want covered by both rule A and rule C", t1110003)
	}
	if !t1098001.Covered || len(t1098001.RuleTitles) != 1 {
		t.Errorf("T1098.001 = %+v, want covered by rule B only", t1098001)
	}
}

func TestBuildCoverage_UncoveredTechniqueIsReportedUncovered(t *testing.T) {
	report := BuildCoverage(nil)
	if report.CoveredCount() != 0 {
		t.Fatalf("CoveredCount() = %d, want 0 for an empty rule set", report.CoveredCount())
	}
	if len(report.Techniques) == 0 {
		t.Fatal("expected the report to enumerate the full catalogue even with no rules")
	}
	for _, tc := range report.Techniques {
		if tc.Covered {
			t.Fatalf("technique %s reported covered with zero rules", tc.ID)
		}
	}
}

func TestBuildCoverage_ExcludesDeprecatedAndRevoked(t *testing.T) {
	report := BuildCoverage(nil)
	for _, tc := range report.Techniques {
		if tc.Deprecated || tc.Revoked {
			t.Fatalf("technique %s is deprecated/revoked and should not appear in a coverage report (nothing should ever target it)", tc.ID)
		}
	}
}

func TestBuildCoverage_TacticTotalsAreNonZero(t *testing.T) {
	report := BuildCoverage(nil)
	if len(report.Tactics) == 0 {
		t.Fatal("expected at least one tactic in the report")
	}
	for _, tac := range report.Tactics {
		if tac.Total == 0 {
			t.Errorf("tactic %q has zero total techniques", tac.Tactic)
		}
	}
}
