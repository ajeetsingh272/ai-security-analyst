package sentinelobs

import (
	"context"
	"io"
	"log/slog"

	"go.opentelemetry.io/otel/trace"
)

// redactingHandler wraps an slog.Handler, injecting tenant_id/trace_id/
// span_id from ctx (mirroring the TypeScript logger's `mixin`) and running
// both the message and every attribute through Redact (mirroring pino's
// `hooks.logMethod` + `formatters.log` pair) before the wrapped handler
// ever sees the record. Wrapping Handle rather than using slog's own
// ReplaceAttr is what lets the message string itself be redacted — slog's
// built-in hook only ever sees individual Attr values, the same gap that
// made the TypeScript logger miss a secret embedded in `msg` the first
// time around.
type redactingHandler struct {
	next slog.Handler
}

func (h *redactingHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h *redactingHandler) Handle(ctx context.Context, r slog.Record) error {
	redacted := slog.NewRecord(r.Time, r.Level, RedactString(r.Message), r.PC)

	if tenantID, ok := TenantIDFromContext(ctx); ok {
		redacted.AddAttrs(slog.String("tenant_id", tenantID))
	}
	if span := trace.SpanContextFromContext(ctx); span.IsValid() {
		redacted.AddAttrs(
			slog.String("trace_id", span.TraceID().String()),
			slog.String("span_id", span.SpanID().String()),
		)
	}

	r.Attrs(func(a slog.Attr) bool {
		redacted.AddAttrs(redactAttr(a))
		return true
	})

	return h.next.Handle(ctx, redacted)
}

func (h *redactingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	redactedAttrs := make([]slog.Attr, len(attrs))
	for i, a := range attrs {
		redactedAttrs[i] = redactAttr(a)
	}
	return &redactingHandler{next: h.next.WithAttrs(redactedAttrs)}
}

func (h *redactingHandler) WithGroup(name string) slog.Handler {
	return &redactingHandler{next: h.next.WithGroup(name)}
}

func redactAttr(a slog.Attr) slog.Attr {
	v := a.Value.Resolve()
	if v.Kind() == slog.KindString {
		return slog.String(a.Key, RedactString(v.String()))
	}
	return a
}

// NewLogger returns a structured JSON logger (AC2) that always carries
// tenant_id and trace_id when the passed context has them, and redacts
// every message and attribute (AC3) — a property of the logger, not
// something a call site has to opt into, same intent as
// packages/observability/src/logger.ts's createLogger.
func NewLogger(service string, w io.Writer) *slog.Logger {
	base := slog.NewJSONHandler(w, &slog.HandlerOptions{Level: slog.LevelInfo})
	return slog.New(&redactingHandler{next: base}).With(slog.String("service", service))
}
