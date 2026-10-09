package customerrules

import (
	"strconv"
	"strings"
	"testing"
)

const validRuleYAML = `
title: Customer test rule
id: cccccccc-0001-4a00-9000-000000000001
status: experimental
description: a test rule
owner_description: a plain-English description of what this detects
author: tenant
date: 2026/10/09
tags:
  - attack.t1110.003
logsource:
  category: application
  product: m365
  service: azuread
detection:
  selection:
    Operation: 'Consent to application.'
    ConsentType: 'AdminConsent'
  condition: selection
level: high
`

// T1's own proxy at the unit level: a rule within every ADR-0012 §1
// limit is accepted — the baseline every rejection test below is
// compared against.
func TestValidate_AcceptsARuleWithinEveryLimit(t *testing.T) {
	r, err := Validate("test-rule", validRuleYAML)
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if r.Title != "Customer test rule" {
		t.Errorf("Title = %q", r.Title)
	}
}

func TestValidate_RejectsWindowedAggregation(t *testing.T) {
	yaml := strings.Replace(validRuleYAML, "condition: selection", "condition: selection | count() by Operation > 5 within 10m", 1)
	_, err := Validate("test-rule", yaml)
	if err == nil {
		t.Fatal("expected a windowed/aggregation rule to be rejected, got nil error")
	}
	if !strings.Contains(err.Error(), "windowed") {
		t.Errorf("error = %q, want it to mention windowed rules are disallowed", err.Error())
	}
}

// T1: "A pathological customer rule is terminated at its resource
// limit" — for this provably-bounded dialect (ADR-0012 §1's own
// argument), the resource limit IS the validator, so "terminated"
// means "never activated in the first place". This constructs a rule
// with more selections than ADR-0012's own table allows and confirms
// it is rejected before it could ever be evaluated against a real
// event.
func TestValidate_RejectsTooManySelections(t *testing.T) {
	var b strings.Builder
	b.WriteString(`
title: Pathological rule
id: cccccccc-0002-4a00-9000-000000000002
status: experimental
description: a test rule
owner_description: a plain-English description
author: tenant
date: 2026/10/09
tags:
  - attack.t1110.003
logsource:
  category: application
  product: m365
  service: azuread
detection:
`)
	for i := 0; i <= maxSelections; i++ {
		b.WriteString("  selection")
		b.WriteString(strconv.Itoa(i))
		b.WriteString(":\n    Operation: 'x'\n")
	}
	b.WriteString("  condition: selection0\nlevel: high\n")

	_, err := Validate("pathological-rule", b.String())
	if err == nil {
		t.Fatal("expected a rule with too many selections to be rejected, got nil error")
	}
	if !strings.Contains(err.Error(), "selections") {
		t.Errorf("error = %q, want it to mention the selection limit", err.Error())
	}
}

func TestValidate_RejectsOverlongRegex(t *testing.T) {
	longPattern := strings.Repeat("a", maxRegexLength+1)
	yaml := strings.Replace(validRuleYAML, "Operation: 'Consent to application.'", "Operation|re: '"+longPattern+"'", 1)
	_, err := Validate("test-rule", yaml)
	if err == nil {
		t.Fatal("expected an overlong regex pattern to be rejected, got nil error")
	}
	if !strings.Contains(err.Error(), "regex") {
		t.Errorf("error = %q, want it to mention the regex limit", err.Error())
	}
}

func TestValidate_RejectsOverlongRuleDefinition(t *testing.T) {
	padded := validRuleYAML + "\n# " + strings.Repeat("x", maxRuleYAMLBytes)
	_, err := Validate("test-rule", padded)
	if err == nil {
		t.Fatal("expected an overlong rule definition to be rejected, got nil error")
	}
	if !strings.Contains(err.Error(), "byte limit") {
		t.Errorf("error = %q, want it to mention the byte limit", err.Error())
	}
}

func TestValidate_RejectsMalformedYAML_SameAsSigmacParse(t *testing.T) {
	_, err := Validate("test-rule", "not: valid: sigma: yaml: at: all:::")
	if err == nil {
		t.Fatal("expected a malformed rule to be rejected, got nil error")
	}
}
