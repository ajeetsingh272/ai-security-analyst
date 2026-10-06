package sigmac

import "testing"

func TestMapField_KnownFieldsResolve(t *testing.T) {
	for sigmaField, wantPath := range fieldMap {
		gotPath, ok := mapField(sigmaField)
		if !ok {
			t.Errorf("mapField(%q): ok=false, want true", sigmaField)
		}
		if gotPath != wantPath {
			t.Errorf("mapField(%q) = %q, want %q", sigmaField, gotPath, wantPath)
		}
	}
}

// T4: "Field mapping failure for an unknown field is an error, not a
// silent no-match."
func TestMapField_UnknownFieldIsNotOK(t *testing.T) {
	_, ok := mapField("ThisFieldDoesNotExistAnywhere")
	if ok {
		t.Fatal("expected ok=false for an unmapped field")
	}
}
