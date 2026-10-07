package attck

import "testing"

// T3: generated navigator layer loads without error in the ATT&CK
// Navigator. A real browser-based Navigator instance isn't available
// here; Validate() checks the same structural requirements
// layerformat.md (mitre-attack/attack-navigator, v4.5) documents as
// required, which is what the Navigator's own loader enforces — the
// closest achievable proxy for "loads without error" without a
// browser.
func TestBuildNavigatorLayer_ValidatesCleanly(t *testing.T) {
	rules := []Rule{
		fakeRule{title: "rule A", tags: []string{"attack.t1110.003"}},
	}
	layer := BuildNavigatorLayer(BuildCoverage(rules))
	if err := layer.Validate(); err != nil {
		t.Fatalf("Validate(): %v", err)
	}
}

func TestBuildNavigatorLayer_RequiredFieldsPresent(t *testing.T) {
	layer := BuildNavigatorLayer(BuildCoverage(nil))
	if layer.Name == "" {
		t.Error("Name is empty")
	}
	if layer.Domain != "enterprise-attack" {
		t.Errorf("Domain = %q, want enterprise-attack", layer.Domain)
	}
	if layer.Versions.Layer != NavigatorLayerVersion {
		t.Errorf("Versions.Layer = %q, want %q", layer.Versions.Layer, NavigatorLayerVersion)
	}
	if layer.Versions.Navigator == "" {
		t.Error("Versions.Navigator is empty")
	}
	if len(layer.Techniques) == 0 {
		t.Error("expected every catalogue technique to appear, even uncovered ones")
	}
}

func TestBuildNavigatorLayer_EveryTechniqueIDIsReal(t *testing.T) {
	layer := BuildNavigatorLayer(BuildCoverage(nil))
	for _, lt := range layer.Techniques {
		if _, ok := Lookup(lt.TechniqueID); !ok {
			t.Errorf("layer references unknown technique id %q", lt.TechniqueID)
		}
	}
}

func TestLayerValidate_RejectsWrongLayerVersion(t *testing.T) {
	layer := BuildNavigatorLayer(BuildCoverage(nil))
	layer.Versions.Layer = "4.4"
	if err := layer.Validate(); err == nil {
		t.Fatal("expected Validate to reject a non-4.5 layer version")
	}
}

func TestLayerValidate_RejectsUnknownTechniqueID(t *testing.T) {
	layer := BuildNavigatorLayer(BuildCoverage(nil))
	layer.Techniques = append(layer.Techniques, LayerTechnique{TechniqueID: "T9999.999"})
	if err := layer.Validate(); err == nil {
		t.Fatal("expected Validate to reject an unknown technique id")
	}
}

func TestLayerValidate_RejectsInvalidDomain(t *testing.T) {
	layer := BuildNavigatorLayer(BuildCoverage(nil))
	layer.Domain = "not-a-real-domain"
	if err := layer.Validate(); err == nil {
		t.Fatal("expected Validate to reject an invalid domain")
	}
}
