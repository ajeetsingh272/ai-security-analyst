package attck

import (
	"strings"
	"testing"
)

func TestNormalizeID(t *testing.T) {
	cases := map[string]string{
		"attack.t1110.003": "T1110.003",
		"attack.T1110":     "T1110",
		"t1098.001":        "T1098.001",
		"T1098.001":        "T1098.001",
	}
	for in, want := range cases {
		if got := NormalizeID(in); got != want {
			t.Errorf("NormalizeID(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLookup_KnownCurrentTechnique(t *testing.T) {
	tech, ok := Lookup("attack.t1110.003")
	if !ok {
		t.Fatal("expected T1110.003 (Password Spraying) to be found")
	}
	if tech.Name != "Password Spraying" {
		t.Errorf("Name = %q, want Password Spraying", tech.Name)
	}
	if tech.Revoked || tech.Deprecated {
		t.Errorf("T1110.003 should be current, got revoked=%v deprecated=%v", tech.Revoked, tech.Deprecated)
	}
}

func TestLookup_UnknownID(t *testing.T) {
	if _, ok := Lookup("attack.t9999.999"); ok {
		t.Fatal("expected a made-up technique id to not be found")
	}
}

// T1: an invalid technique id fails the build.
func TestValidateRuleTags_UnknownIDFails(t *testing.T) {
	errs := ValidateRuleTags("Test rule", []string{"attack.t9999.999"})
	if len(errs) != 1 {
		t.Fatalf("got %d errors, want 1: %v", len(errs), errs)
	}
	if !strings.Contains(errs[0].Error(), "not a known ATT&CK technique") {
		t.Errorf("error = %q, want it to explain the id is unknown", errs[0].Error())
	}
}

// T1: a retired (revoked) technique id fails the build — proven against
// a REAL retired id, not a synthetic one, since that's the exact
// mistake this check exists to catch (T1562.001 was revoked by ATT&CK
// in favour of T1685; this corpus used to use it before this ticket).
func TestValidateRuleTags_RevokedIDFails(t *testing.T) {
	errs := ValidateRuleTags("Test rule", []string{"attack.t1562.001"})
	if len(errs) != 1 {
		t.Fatalf("got %d errors, want 1: %v", len(errs), errs)
	}
	if !strings.Contains(errs[0].Error(), "revoked") {
		t.Errorf("error = %q, want it to explain the id is revoked", errs[0].Error())
	}
}

func TestValidateRuleTags_ValidIDsPassCleanly(t *testing.T) {
	errs := ValidateRuleTags("Test rule", []string{"attack.t1110.003", "attack.t1685", "attack.t1685.002"})
	if len(errs) != 0 {
		t.Fatalf("expected no errors for valid, current technique ids, got: %v", errs)
	}
}

type fakeRule struct {
	title string
	tags  []string
}

func (r fakeRule) Title() string       { return r.title }
func (r fakeRule) MitreTags() []string { return r.tags }

func TestValidateCorpus_CollectsEveryProblem(t *testing.T) {
	rules := []Rule{
		fakeRule{title: "good rule", tags: []string{"attack.t1110.003"}},
		fakeRule{title: "bad rule 1", tags: []string{"attack.t9999.999"}},
		fakeRule{title: "bad rule 2", tags: []string{"attack.t1562.008"}},
	}
	errs := ValidateCorpus(rules)
	if len(errs) != 2 {
		t.Fatalf("got %d errors, want 2 (one per bad rule): %v", len(errs), errs)
	}
}
