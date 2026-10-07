package sigmac

import (
	"strings"
	"testing"
)

const corpusDir = "../../../../detections/rules"

// T1: "Parses every rule in the committed corpus without error."
func TestParseCorpus_EveryCommittedRuleParses(t *testing.T) {
	rules, errs := ParseCorpus(corpusDir)
	for _, err := range errs {
		t.Errorf("corpus parse error: %v", err)
	}
	if len(rules) == 0 {
		t.Fatal("expected at least one rule to parse from the committed corpus")
	}
	for _, r := range rules {
		if r.SpecVersion != SpecVersion {
			t.Errorf("rule %q: SpecVersion = %q, want %q", r.Title, r.SpecVersion, SpecVersion)
		}
		if len(r.MitreIDs) == 0 {
			t.Errorf("rule %q: no MITRE ATT&CK ids extracted", r.Title)
		}
	}
}

// The committed corpus's own windowed/in-stream split — a concrete,
// checkable claim about engine routing, not just "it parsed".
func TestParseCorpus_EngineRouting(t *testing.T) {
	rules, errs := ParseCorpus(corpusDir)
	if len(errs) != 0 {
		t.Fatalf("corpus failed to parse: %v", errs)
	}
	windowed, inStream := 0, 0
	for _, r := range rules {
		switch r.Engine {
		case EngineWindowed:
			windowed++
			if r.Aggregation == nil {
				t.Errorf("rule %q: Engine=Windowed but Aggregation is nil", r.Title)
			}
		case EngineInStream:
			inStream++
			if r.Aggregation != nil {
				t.Errorf("rule %q: Engine=InStream but Aggregation is set", r.Title)
			}
		}
	}
	if windowed == 0 {
		t.Error("expected at least one windowed rule in the committed corpus (mass-mailbox-download.yml etc.)")
	}
	if inStream == 0 {
		t.Error("expected at least one in-stream rule in the committed corpus")
	}
}

// T2: "Unsupported construct produces a precise, actionable error."
func TestParse_UnsupportedConstructs(t *testing.T) {
	cases := []struct {
		name    string
		yaml    string
		wantErr string
	}{
		{
			name: "missing MITRE tag",
			yaml: baseRuleYAML(t, "", `
detection:
  selection:
    Operation: 'Foo'
  condition: selection
level: low
`),
			wantErr: "MITRE ATT&CK tag",
		},
		{
			name: "unsupported modifier",
			yaml: baseRuleYAML(t, "attack.t1078", `
detection:
  selection:
    Operation|frobnicate: 'Foo'
  condition: selection
level: low
`),
			wantErr: "unsupported modifier",
		},
		{
			name: "undefined selection in condition",
			yaml: baseRuleYAML(t, "attack.t1078", `
detection:
  selection:
    Operation: 'Foo'
  condition: nonexistent_selection
level: low
`),
			wantErr: "not defined",
		},
		{
			name: "condition is not a string",
			yaml: baseRuleYAML(t, "attack.t1078", `
detection:
  selection:
    Operation: 'Foo'
  condition: [selection]
level: low
`),
			wantErr: "must be a string",
		},
		{
			name: "two value modifiers on one field",
			yaml: baseRuleYAML(t, "attack.t1078", `
detection:
  selection:
    Operation|contains|endswith: 'Foo'
  condition: selection
level: low
`),
			wantErr: "combines two value modifiers",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Parse("test.yml", []byte(tc.yaml))
			if err == nil {
				t.Fatalf("expected a parse error, got none")
			}
			var pe *ParseError
			if !asParseError(err, &pe) {
				t.Fatalf("expected a *ParseError, got %T: %v", err, err)
			}
			if pe.File != "test.yml" {
				t.Errorf("ParseError.File = %q, want %q", pe.File, "test.yml")
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("error %q does not contain %q", err.Error(), tc.wantErr)
			}
		})
	}
}

// T4: "Field mapping failure for an unknown field is an error, not a
// silent no-match" — proven end to end through Parse, not just mapField
// directly (fieldmap_test.go already covers that in isolation).
func TestParse_UnknownFieldIsAnError(t *testing.T) {
	y := baseRuleYAML(t, "attack.t1078", `
detection:
  selection:
    ThisFieldIsNotInTheMappingTable: 'Foo'
  condition: selection
level: low
`)
	_, err := Parse("test.yml", []byte(y))
	if err == nil {
		t.Fatal("expected an error for an unmapped field")
	}
	if !strings.Contains(err.Error(), "ThisFieldIsNotInTheMappingTable") {
		t.Errorf("error does not name the offending field: %v", err)
	}
	if !strings.Contains(err.Error(), "not a silent no-match") {
		t.Errorf("error does not explain AC4's own reasoning: %v", err)
	}
}

// T3: "Each supported modifier produces the expected intermediate
// representation."
func TestParse_ModifiersProduceExpectedIR(t *testing.T) {
	cases := []struct {
		name       string
		fieldLine  string
		wantMod    Modifier
		wantAllOf  bool
		wantValues []string
	}{
		{"equals (implicit)", "Operation: 'Foo'", ModEquals, false, []string{"Foo"}},
		{"contains", "Operation|contains: 'Foo'", ModContains, false, []string{"Foo"}},
		{"startswith", "Operation|startswith: 'Foo'", ModStartsWith, false, []string{"Foo"}},
		{"endswith", "Operation|endswith: 'Foo'", ModEndsWith, false, []string{"Foo"}},
		{"re", "Operation|re: '^Foo.*'", ModRegex, false, []string{"^Foo.*"}},
		{"base64", "Operation|base64: 'Rm9v'", ModBase64, false, []string{"Rm9v"}},
		{"all (list AND)", "Operation|contains|all: ['Foo', 'Bar']", ModContains, true, []string{"Foo", "Bar"}},
		{"list (implicit OR)", "Operation: ['Foo', 'Bar']", ModEquals, false, []string{"Foo", "Bar"}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			y := baseRuleYAML(t, "attack.t1078", `
detection:
  selection:
    `+tc.fieldLine+`
  condition: selection
level: low
`)
			rule, err := Parse("test.yml", []byte(y))
			if err != nil {
				t.Fatalf("Parse: %v", err)
			}
			sel := rule.Selections["selection"]
			if len(sel.Fields) != 1 {
				t.Fatalf("expected exactly 1 field match, got %d", len(sel.Fields))
			}
			fm := sel.Fields[0]
			if fm.Modifier != tc.wantMod {
				t.Errorf("Modifier = %v, want %v", fm.Modifier, tc.wantMod)
			}
			if fm.AllOf != tc.wantAllOf {
				t.Errorf("AllOf = %v, want %v", fm.AllOf, tc.wantAllOf)
			}
			if len(fm.Values) != len(tc.wantValues) {
				t.Fatalf("Values = %v, want %v", fm.Values, tc.wantValues)
			}
			for i, v := range tc.wantValues {
				if fm.Values[i] != v {
					t.Errorf("Values[%d] = %q, want %q", i, fm.Values[i], v)
				}
			}
			if fm.OCSFPath != "metadata.operation" {
				t.Errorf("OCSFPath = %q, want %q", fm.OCSFPath, "metadata.operation")
			}
		})
	}
}

func TestParse_AggregationRoutesToWindowedEngine(t *testing.T) {
	y := baseRuleYAML(t, "attack.t1078", `
detection:
  selection:
    Operation: 'MailItemsAccessed'
  condition: selection | count() by UserId > 500 within 10m
level: high
`)
	rule, err := Parse("test.yml", []byte(y))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if rule.Engine != EngineWindowed {
		t.Errorf("Engine = %v, want Windowed", rule.Engine)
	}
	if rule.Aggregation == nil {
		t.Fatal("expected a non-nil Aggregation")
	}
	if rule.Aggregation.Threshold != 500 || rule.Aggregation.Comparator != ">" {
		t.Errorf("Aggregation = %+v", rule.Aggregation)
	}
}

func TestParse_OfPatternMatchesWildcardSelections(t *testing.T) {
	y := baseRuleYAML(t, "attack.t1078", `
detection:
  selection1:
    Operation: 'FileDownloaded'
  selection2:
    Operation: 'FileDeleted'
  condition: 1 of selection*
level: high
`)
	rule, err := Parse("test.yml", []byte(y))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	of, ok := rule.Condition.(OfExpr)
	if !ok {
		t.Fatalf("Condition = %#v, want OfExpr", rule.Condition)
	}
	if of.Pattern != "selection*" {
		t.Errorf("Pattern = %q", of.Pattern)
	}
}

// AC5: "Parse errors identify the file, line and construct."
func TestParse_ErrorIdentifiesSourceLine(t *testing.T) {
	y := "title: Test rule\nid: test-rule-id\nstatus: stable\ntags:\n  - attack.t1078\ndetection:\n  selection:\n    Operation: 'Foo'\n    BadField|frobnicate: 'Bar'\n  condition: selection\nlevel: low\n"
	// BadField|frobnicate is on line 9 (1-indexed) of the string above.
	_, err := Parse("test.yml", []byte(y))
	if err == nil {
		t.Fatal("expected a parse error")
	}
	var pe *ParseError
	if !asParseError(err, &pe) {
		t.Fatalf("expected a *ParseError, got %T", err)
	}
	if pe.Line != 9 {
		t.Errorf("Line = %d, want 9 (full error: %v)", pe.Line, err)
	}
	if pe.File != "test.yml" {
		t.Errorf("File = %q", pe.File)
	}
}

// baseRuleYAML builds a complete, otherwise-valid rule YAML string with
// the given MITRE tag (empty string omits the tags block entirely) and
// detection/level block spliced in — test cases only need to vary the
// one construct under test, not restate every required field.
func baseRuleYAML(t *testing.T, mitreTag, detectionAndLevel string) string {
	t.Helper()
	tags := ""
	if mitreTag != "" {
		tags = "tags:\n  - " + mitreTag + "\n"
	}
	return "title: Test rule\nid: test-rule-id\nstatus: stable\n" + tags + detectionAndLevel
}

// asParseError is a tiny errors.As wrapper kept local to avoid an extra
// import line at every call site above.
func asParseError(err error, target **ParseError) bool {
	for err != nil {
		if pe, ok := err.(*ParseError); ok {
			*target = pe
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}
