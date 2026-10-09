package customerrules

import (
	"strings"
	"testing"

	"github.com/ajeetsingh272/ai-security-analyst/services/detect/internal/sigmac"
)

var (
	matchingFixture    = sigmac.Event{"metadata.operation": "Consent to application.", "unmapped.ConsentType": "AdminConsent"}
	nonMatchingFixture = sigmac.Event{"metadata.operation": "Consent to application.", "unmapped.ConsentType": "UserConsent"}
)

// T4: "A rule failing its own fixtures cannot be activated."
func TestValidateAgainstFixtures_AcceptsACorrectFixturePair(t *testing.T) {
	r, err := Validate("test-rule", validRuleYAML)
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if err := ValidateAgainstFixtures(r, matchingFixture, nonMatchingFixture); err != nil {
		t.Errorf("ValidateAgainstFixtures: %v", err)
	}
}

func TestValidateAgainstFixtures_RejectsAPositiveFixtureThatDoesNotMatch(t *testing.T) {
	r, err := Validate("test-rule", validRuleYAML)
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if err := ValidateAgainstFixtures(r, nonMatchingFixture, nonMatchingFixture); err == nil {
		t.Fatal("expected an error for a positive fixture that does not match, got nil")
	} else if !strings.Contains(err.Error(), "positive fixture") {
		t.Errorf("error = %q, want it to mention the positive fixture", err.Error())
	}
}

func TestValidateAgainstFixtures_RejectsANegativeFixtureThatDoesMatch(t *testing.T) {
	r, err := Validate("test-rule", validRuleYAML)
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if err := ValidateAgainstFixtures(r, matchingFixture, matchingFixture); err == nil {
		t.Fatal("expected an error for a negative fixture that does match, got nil")
	} else if !strings.Contains(err.Error(), "negative fixture") {
		t.Errorf("error = %q, want it to mention the negative fixture", err.Error())
	}
}
