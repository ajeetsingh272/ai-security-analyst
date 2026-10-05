/**
 * Structured JSON logging that always carries `tenant_id` and `trace_id`
 * (P0-10 AC2), with every log passed through the redaction layer (AC3) —
 * not as something a call site opts into, but as a property of calling
 * `logger.info(...)` at all.
 *
 * `tenant_id` comes from @sentinel/db's tenant context (P0-05) — the SAME
 * AsyncLocalStorage a request's TenantScopedRepository reads, so a log line
 * written from inside `withTenantContext`/`enterTenantContext` is
 * automatically attributed to the right tenant with no parameter to pass or
 * forget. `trace_id` comes from OpenTelemetry's active span, read via
 * `@opentelemetry/api` — correct regardless of which service or language
 * started the trace, because trace context, unlike tenant_id, is a wire
 * protocol (W3C traceparent) that crosses the Go/TypeScript boundary on its
 * own; this file only ever reads whatever is already active.
 */
import pino from 'pino';
import { trace } from '@opentelemetry/api';
import { hasTenantContext, getTenantContext } from '@sentinel/db';
import { redact } from './redact.js';

/** Pino's `mixin` runs once per log call and its return value is merged
 * into the log object — this is where tenant_id/trace_id get attached,
 * rather than requiring every call site to pass them explicitly. */
function mixin(): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  if (hasTenantContext()) {
    fields.tenant_id = getTenantContext().tenantId;
  }

  const span = trace.getActiveSpan();
  if (span) {
    const ctx = span.spanContext();
    // "0" repeated is OpenTelemetry's own sentinel for "no real trace is
    // active" (an invalid/no-op span) — skip rather than log a fake id that
    // would look like a real, searchable trace in Jaeger and never resolve.
    if (ctx.traceId !== '00000000000000000000000000000000') {
      fields.trace_id = ctx.traceId;
      fields.span_id = ctx.spanId;
    }
  }

  return fields;
}

/** Applied to the structured merging object right before pino serialises
 * it — e.g. `logger.info({ headers }, 'calling out')`'s first argument. */
function redactingFormatter(obj: Record<string, unknown>): Record<string, unknown> {
  return redact(obj) as Record<string, unknown>;
}

/** Pino's `formatters.log` never sees the message string itself — pino
 * splits `logger.info('msg', ...)`'s arguments into the merging object and
 * `msg` before any formatter runs, so a secret typed directly into the
 * message (`logger.info(\`retry with api_key=${key}\`)`) would sail through
 * `redactingFormatter` untouched. `hooks.logMethod` intercepts the raw
 * argument list earlier than that split, so redacting every string argument
 * here catches it. */
function redactLogMethod(
  this: pino.Logger,
  args: unknown[],
  method: (...args: unknown[]) => void,
): void {
  const redacted = args.map((arg) => (typeof arg === 'string' ? redact(arg) : arg));
  method.apply(this, redacted);
}

export interface CreateLoggerOptions {
  service: string;
  level?: string;
  /** Pino's destination stream. Exists so tests can capture output without
   * a real file or network sink — pino only accepts a destination as the
   * factory's second positional argument at construction time, with no
   * supported way to redirect it afterward, so this has to be a
   * construction-time option rather than something set post-hoc. */
  destination?: NodeJS.WritableStream;
}

export function createLogger({
  service,
  level = process.env.LOG_LEVEL ?? 'info',
  destination,
}: CreateLoggerOptions) {
  const options = {
    level,
    base: { service },
    mixin,
    formatters: { log: redactingFormatter },
    hooks: { logMethod: redactLogMethod },
    // ISO timestamps, not pino's default epoch millis — a structured log a
    // human actually reads (locally, or in whatever aggregates these later)
    // should not require a conversion step to know when something happened.
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination ? pino(options, destination) : pino(options);
}

export type Logger = ReturnType<typeof createLogger>;
