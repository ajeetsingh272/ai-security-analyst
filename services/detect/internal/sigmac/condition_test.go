package sigmac

import (
	"testing"
)

func mustParseCondition(t *testing.T, s string) ConditionExpr {
	t.Helper()
	expr, err := parseCondition(s)
	if err != nil {
		t.Fatalf("parseCondition(%q): %v", s, err)
	}
	return expr
}

func TestParseCondition_Simple(t *testing.T) {
	expr := mustParseCondition(t, "selection")
	ref, ok := expr.(SelectionRef)
	if !ok || ref.Name != "selection" {
		t.Fatalf("got %#v, want SelectionRef{selection}", expr)
	}
}

func TestParseCondition_AndOrNotPrecedence(t *testing.T) {
	// "a and b or c" must parse as (a and b) or c — and binds tighter than or.
	expr := mustParseCondition(t, "a and b or c")
	or, ok := expr.(OrExpr)
	if !ok {
		t.Fatalf("top level = %#v, want OrExpr", expr)
	}
	and, ok := or.X.(AndExpr)
	if !ok {
		t.Fatalf("left of or = %#v, want AndExpr", or.X)
	}
	if and.X.(SelectionRef).Name != "a" || and.Y.(SelectionRef).Name != "b" {
		t.Fatalf("and = %#v", and)
	}
	if or.Y.(SelectionRef).Name != "c" {
		t.Fatalf("right of or = %#v", or.Y)
	}
}

func TestParseCondition_NotBindsTighterThanAnd(t *testing.T) {
	expr := mustParseCondition(t, "a and not b")
	and := expr.(AndExpr)
	not, ok := and.Y.(NotExpr)
	if !ok {
		t.Fatalf("right of and = %#v, want NotExpr", and.Y)
	}
	if not.X.(SelectionRef).Name != "b" {
		t.Fatalf("not's operand = %#v", not.X)
	}
}

func TestParseCondition_Parentheses(t *testing.T) {
	// "(a or b) and c" — without the parens this would parse as a or (b and c).
	expr := mustParseCondition(t, "(a or b) and c")
	and, ok := expr.(AndExpr)
	if !ok {
		t.Fatalf("top level = %#v, want AndExpr", expr)
	}
	or, ok := and.X.(OrExpr)
	if !ok {
		t.Fatalf("left of and = %#v, want OrExpr", and.X)
	}
	if or.X.(SelectionRef).Name != "a" || or.Y.(SelectionRef).Name != "b" {
		t.Fatalf("or = %#v", or)
	}
}

func TestParseCondition_OfExpr(t *testing.T) {
	cases := []struct {
		in        string
		wantCount int
		wantPat   string
	}{
		{"1 of selection*", 1, "selection*"},
		{"all of selection*", -1, "selection*"},
		{"2 of filter*", 2, "filter*"},
	}
	for _, tc := range cases {
		expr := mustParseCondition(t, tc.in)
		of, ok := expr.(OfExpr)
		if !ok {
			t.Fatalf("%q: got %#v, want OfExpr", tc.in, expr)
		}
		if of.Count != tc.wantCount || of.Pattern != tc.wantPat {
			t.Fatalf("%q: got %+v, want {Count:%d Pattern:%s}", tc.in, of, tc.wantCount, tc.wantPat)
		}
	}
}

func TestParseCondition_RejectsGarbage(t *testing.T) {
	cases := []string{
		"",
		"and",
		"a and",
		"(a",
		"a b", // two identifiers with no operator between them
	}
	for _, c := range cases {
		if _, err := parseCondition(c); err == nil {
			t.Errorf("parseCondition(%q): expected an error, got none", c)
		}
	}
}

func TestParseAggregation_NoneWhenNoPipe(t *testing.T) {
	agg, err := parseAggregation("selection")
	if err != nil {
		t.Fatalf("parseAggregation: %v", err)
	}
	if agg != nil {
		t.Fatalf("expected nil aggregation for a plain condition, got %+v", agg)
	}
}

func TestParseAggregation_CountByWithWithin(t *testing.T) {
	agg, err := parseAggregation("selection | count() by UserId, ClientIP > 5 within 10m")
	if err != nil {
		t.Fatalf("parseAggregation: %v", err)
	}
	if agg == nil {
		t.Fatal("expected a non-nil aggregation")
	}
	if len(agg.GroupBy) != 2 || agg.GroupBy[0] != "UserId" || agg.GroupBy[1] != "ClientIP" {
		t.Fatalf("GroupBy = %v", agg.GroupBy)
	}
	if agg.Comparator != ">" || agg.Threshold != 5 {
		t.Fatalf("Comparator=%q Threshold=%d", agg.Comparator, agg.Threshold)
	}
	if agg.Window.String() != "10m0s" {
		t.Fatalf("Window = %v", agg.Window)
	}
}

func TestParseAggregation_DefaultWindow(t *testing.T) {
	agg, err := parseAggregation("selection | count() by UserId >= 3")
	if err != nil {
		t.Fatalf("parseAggregation: %v", err)
	}
	if agg.Window.String() != "5m0s" {
		t.Fatalf("expected the documented 5m default window, got %v", agg.Window)
	}
}

func TestParseAggregation_RejectsUnsupportedComparator(t *testing.T) {
	if _, err := parseAggregation("selection | count() by UserId != 3"); err == nil {
		t.Fatal("expected an error for an unsupported comparator")
	}
}
