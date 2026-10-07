package sentinelattck

import "testing"

func TestNormalizeID(t *testing.T) {
	cases := map[string]string{
		"attack.t1110.003": "T1110.003",
		"T1110.003":        "T1110.003",
		"t1110":            "T1110",
		"attack.T1110":     "T1110",
		"":                 "",
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
		t.Fatal("expected T1110.003 to be found in the pinned catalogue")
	}
	if tech.ID != "T1110.003" {
		t.Errorf("got ID %q, want T1110.003", tech.ID)
	}
	if len(tech.Tactics) == 0 {
		t.Error("expected at least one tactic")
	}
}

func TestLookup_UnknownID(t *testing.T) {
	if _, ok := Lookup("attack.t9999.999"); ok {
		t.Error("expected T9999.999 to be unknown")
	}
}

func TestAll_ReturnsEveryPinnedTechnique(t *testing.T) {
	if len(All()) == 0 {
		t.Fatal("expected a non-empty catalogue")
	}
}
