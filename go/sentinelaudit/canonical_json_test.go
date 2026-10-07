package sentinelaudit

import "testing"

func TestCanonicalJSON_SortsKeysAtEveryLevel(t *testing.T) {
	got, err := CanonicalJSON(map[string]any{
		"b": float64(2), "a": float64(1),
		"nested": map[string]any{"z": float64(1), "y": float64(2)},
	})
	if err != nil {
		t.Fatalf("CanonicalJSON: %v", err)
	}
	want := `{"a":1,"b":2,"nested":{"y":2,"z":1}}`
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestCanonicalJSON_PreservesArrayOrder(t *testing.T) {
	got, err := CanonicalJSON([]any{float64(3), float64(1), float64(2)})
	if err != nil {
		t.Fatalf("CanonicalJSON: %v", err)
	}
	if got != "[3,1,2]" {
		t.Errorf("got %q, want [3,1,2] (array order must NOT be sorted)", got)
	}
}

func TestCanonicalJSON_EscapesStringsLikeJSONStringify(t *testing.T) {
	got, err := CanonicalJSON(`quote"and\backslash` + "\n\t")
	if err != nil {
		t.Fatalf("CanonicalJSON: %v", err)
	}
	want := `"quote\"and\\backslash\n\t"`
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestCanonicalJSON_DoesNotHTMLEscape(t *testing.T) {
	// The exact failure mode encoding/json.Marshal would introduce —
	// JS's JSON.stringify never escapes these.
	got, err := CanonicalJSON("<script>&</script>")
	if err != nil {
		t.Fatalf("CanonicalJSON: %v", err)
	}
	want := `"<script>&</script>"`
	if got != want {
		t.Errorf("got %q, want %q (must not HTML-escape)", got, want)
	}
}

func TestCanonicalJSON_WholeNumberFloatPrintsWithoutDecimalPoint(t *testing.T) {
	got, err := CanonicalJSON(map[string]any{"n": float64(3)})
	if err != nil {
		t.Fatalf("CanonicalJSON: %v", err)
	}
	if got != `{"n":3}` {
		t.Errorf("got %q, want {\"n\":3} (not {\"n\":3.0} — JS prints whole numbers without a decimal point)", got)
	}
}

func TestCanonicalJSON_NullBoolAndEmptyValues(t *testing.T) {
	got, err := CanonicalJSON(map[string]any{"n": nil, "t": true, "f": false, "empty": map[string]any{}, "arr": []any{}})
	if err != nil {
		t.Fatalf("CanonicalJSON: %v", err)
	}
	want := `{"arr":[],"empty":{},"f":false,"n":null,"t":true}`
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestCanonicalJSON_UnsupportedTypeReturnsError(t *testing.T) {
	type weird struct{ X int }
	if _, err := CanonicalJSON(weird{X: 1}); err == nil {
		t.Fatal("expected an error for an unsupported type, got nil")
	}
}
