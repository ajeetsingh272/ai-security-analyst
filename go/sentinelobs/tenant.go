// Package sentinelobs is the Go half of P0-10's observability baseline:
// structured logging with redaction, tracing and golden-signal metrics,
// mirroring packages/observability's TypeScript side so a trace or a log
// line looks the same regardless of which language emitted it.
package sentinelobs

import "context"

type tenantIDKey struct{}

// WithTenantID attaches a tenant id to ctx, the Go-idiomatic equivalent of
// @sentinel/db's AsyncLocalStorage-based tenant context on the TypeScript
// side (ADR-0008) — Go has no ambient storage, so the context value IS the
// propagation mechanism, carried explicitly through every call that needs
// it rather than read implicitly off a goroutine-local.
func WithTenantID(ctx context.Context, tenantID string) context.Context {
	return context.WithValue(ctx, tenantIDKey{}, tenantID)
}

// TenantIDFromContext returns the tenant id attached by WithTenantID, if
// any. Mirrors @sentinel/db's hasTenantContext/getTenantContext pair as a
// single ok-boolean lookup, Go's idiomatic shape for "present or absent".
func TenantIDFromContext(ctx context.Context) (string, bool) {
	v, ok := ctx.Value(tenantIDKey{}).(string)
	return v, ok
}
