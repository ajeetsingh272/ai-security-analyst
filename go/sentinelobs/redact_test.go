package sentinelobs

import (
	"strings"
	"testing"
)

func TestRedactStringStripsBearerToken(t *testing.T) {
	out := RedactString("Authorization: Bearer abc123.XYZ-token_value==")
	if strings.Contains(out, "abc123") {
		t.Fatalf("bearer token leaked: %q", out)
	}
	if !strings.Contains(out, "[REDACTED]") {
		t.Fatalf("expected redaction marker, got %q", out)
	}
}

func TestRedactStringStripsAWSAccessKey(t *testing.T) {
	out := RedactString("key_id=AKIAIOSFODNN7EXAMPLE")
	if strings.Contains(out, "AKIAIOSFODNN7EXAMPLE") {
		t.Fatalf("aws key leaked: %q", out)
	}
}

func TestRedactStringStripsJWT(t *testing.T) {
	jwt := "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
	out := RedactString("token=" + jwt)
	if strings.Contains(out, jwt) || strings.Contains(out, "eyJ") {
		t.Fatalf("jwt leaked: %q", out)
	}
}

func TestRedactStringStripsPEMBlock(t *testing.T) {
	pem := "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\n-----END RSA PRIVATE KEY-----"
	out := RedactString("cert: " + pem)
	if strings.Contains(out, "MIIBOgIBAAJBAK") || strings.Contains(out, "BEGIN RSA PRIVATE KEY") {
		t.Fatalf("pem block leaked: %q", out)
	}
}

func TestRedactStringKeepsFieldNameVisible(t *testing.T) {
	out := RedactString(`password: "sup3rSecret!"`)
	if strings.Contains(out, "sup3rSecret") {
		t.Fatalf("password value leaked: %q", out)
	}
	if !strings.Contains(out, "password") {
		t.Fatalf("expected field name to survive redaction: %q", out)
	}
}

func TestRedactStringHandlesEqualsForm(t *testing.T) {
	out := RedactString("api_key=sk_live_abc123XYZ")
	if strings.Contains(out, "sk_live_abc123XYZ") {
		t.Fatalf("api key leaked: %q", out)
	}
}

func TestRedactWalksNestedMapsAndSlices(t *testing.T) {
	out := Redact(map[string]any{
		"user": map[string]any{
			"email":    "a@example.com",
			"password": "hunter2hunter2",
		},
		"headers": []any{"Authorization: Bearer leaked-token-value-here"},
	}, 0).(map[string]any)

	user := out["user"].(map[string]any)
	if user["password"] != redacted {
		t.Fatalf("expected password redacted wholesale by key name, got %v", user["password"])
	}
	if user["email"] != "a@example.com" {
		t.Fatalf("non-secret field should survive untouched, got %v", user["email"])
	}
	headers := out["headers"].([]any)
	if strings.Contains(headers[0].(string), "leaked-token-value-here") {
		t.Fatalf("bearer token in slice leaked: %v", headers)
	}
}

func TestRedactLeavesBenignDataAlone(t *testing.T) {
	out := Redact(map[string]any{"action": "case.viewed", "count": 42}, 0).(map[string]any)
	if out["action"] != "case.viewed" || out["count"] != 42 {
		t.Fatalf("benign data should be untouched, got %v", out)
	}
}

func TestRedactStringNoFalsePositiveOnVersionString(t *testing.T) {
	out := RedactString("schemaVersion=1.2.3")
	if out != "schemaVersion=1.2.3" {
		t.Fatalf("expected no change to a plain version string, got %q", out)
	}
}

func TestRedactIsDepthLimited(t *testing.T) {
	var deep any = "leaf"
	for i := 0; i < 50; i++ {
		deep = map[string]any{"child": deep}
	}
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Redact panicked on deep nesting: %v", r)
		}
	}()
	Redact(deep, 0)
}
