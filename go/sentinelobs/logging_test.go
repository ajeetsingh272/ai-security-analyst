package sentinelobs

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/sdk/trace"
)

func parseLine(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()
	var line map[string]any
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatalf("log line is not valid JSON: %v\n%s", err, buf.String())
	}
	return line
}

func TestNewLoggerAttachesServiceName(t *testing.T) {
	var buf bytes.Buffer
	logger := NewLogger("tenant-api", &buf)
	logger.Info("hello", "action", "probe")

	line := parseLine(t, &buf)
	if line["service"] != "tenant-api" {
		t.Fatalf("expected service=tenant-api, got %v", line["service"])
	}
	if line["action"] != "probe" {
		t.Fatalf("expected action=probe, got %v", line["action"])
	}
	if line["msg"] != "hello" {
		t.Fatalf("expected msg=hello, got %v", line["msg"])
	}
}

func TestNewLoggerAttachesTenantIDWhenPresent(t *testing.T) {
	var buf bytes.Buffer
	logger := NewLogger("x", &buf)

	ctx := WithTenantID(context.Background(), "11111111-1111-4111-8111-111111111111")
	logger.InfoContext(ctx, "inside tenant context")

	line := parseLine(t, &buf)
	if line["tenant_id"] != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("expected tenant_id attached, got %v", line["tenant_id"])
	}
}

func TestNewLoggerOmitsTenantIDWhenAbsent(t *testing.T) {
	var buf bytes.Buffer
	logger := NewLogger("x", &buf)
	logger.InfoContext(context.Background(), "outside any tenant context")

	line := parseLine(t, &buf)
	if _, present := line["tenant_id"]; present {
		t.Fatalf("expected no tenant_id, got %v", line["tenant_id"])
	}
}

func TestNewLoggerAttachesTraceAndSpanIDWhenActive(t *testing.T) {
	var buf bytes.Buffer
	logger := NewLogger("x", &buf)

	tp := trace.NewTracerProvider()
	tracer := tp.Tracer("test")
	ctx, span := tracer.Start(context.Background(), "probe-span")
	logger.InfoContext(ctx, "inside a span")
	span.End()

	line := parseLine(t, &buf)
	traceID, _ := line["trace_id"].(string)
	spanID, _ := line["span_id"].(string)
	if len(traceID) != 32 {
		t.Fatalf("expected a 32-char trace_id, got %q", traceID)
	}
	if len(spanID) != 16 {
		t.Fatalf("expected a 16-char span_id, got %q", spanID)
	}
}

func TestNewLoggerRedactsSecretInStructuredField(t *testing.T) {
	var buf bytes.Buffer
	logger := NewLogger("x", &buf)
	logger.Info("calling out", "authorization", "Bearer super-secret-value-here")

	if strings.Contains(buf.String(), "super-secret-value-here") {
		t.Fatalf("secret leaked in structured field: %s", buf.String())
	}
}

func TestNewLoggerRedactsSecretEmbeddedInMessageString(t *testing.T) {
	var buf bytes.Buffer
	logger := NewLogger("x", &buf)
	logger.Info("retrying with api_key=sk_live_abc123XYZSECRET")

	line := parseLine(t, &buf)
	msg, _ := line["msg"].(string)
	if strings.Contains(msg, "sk_live_abc123XYZSECRET") {
		t.Fatalf("secret leaked in message string: %q", msg)
	}
}
