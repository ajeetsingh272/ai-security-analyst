/**
 * P0-10 T1: a synthetic event produces one unbroken trace spanning a
 * TypeScript caller and the Go `ingest` service — the literal proof that a
 * trace_id propagates across the language boundary (AC1), not just within
 * one process.
 *
 * Needs: `pnpm dev:stack` running (otel-collector + Jaeger) and a Go
 * toolchain on PATH to build services/ingest. There's no existing
 * precedent in this repo for spawning a long-lived Go service from a Node
 * test — roundtrip-check.mjs's spawnSync('go', ['run', ...]) is the closest
 * analogue, but that's a one-shot CLI, not an HTTP server kept alive for
 * the test — so this establishes that pattern.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { context, trace } from '@opentelemetry/api';
import { startTracing, type TracingHandle } from '../tracing.js';

const INGEST_DIR = path.resolve(import.meta.dirname, '../../../../services/ingest');
const INGEST_BIN = path.join(INGEST_DIR, process.platform === 'win32' ? 'ingest-test.exe' : 'ingest-test');
const INGEST_URL = 'http://127.0.0.1:18101';
const JAEGER_URL = 'http://localhost:16686';
const SERVICE_NAME = 'sentinel-api-synthetic-test';

interface JaegerTrace {
  spans: unknown[];
  processes: Record<string, { serviceName: string }>;
}

async function waitForHealthy(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) return;
    } catch {
      // ingest hasn't bound its listener yet — retry.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`ingest did not become healthy within ${timeoutMs}ms`);
}

/**
 * Polls until the trace is present AND carries spans from every service in
 * `expectedServices` — not just until it has *a* span. The TypeScript side
 * flushes (and is queryable) almost immediately once shutdown() is called,
 * well before the Go side's own batch exporter has sent anything; stopping
 * at "the trace exists" would pass this test on the TypeScript-only half of
 * the trace alone, which defeats the point of T1.
 */
async function waitForJaegerTrace(
  traceId: string,
  expectedServices: readonly string[],
  timeoutMs: number,
): Promise<JaegerTrace> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen: JaegerTrace | undefined;
  while (Date.now() < deadline) {
    const res = await fetch(`${JAEGER_URL}/api/traces/${traceId}`);
    if (res.ok) {
      const body = (await res.json()) as { data?: JaegerTrace[] };
      const found = body.data?.[0];
      if (found && found.spans.length > 0) {
        lastSeen = found;
        const serviceNames = new Set(Object.values(found.processes).map((p) => p.serviceName));
        if (expectedServices.every((s) => serviceNames.has(s))) return found;
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `trace ${traceId} did not carry spans from all of [${expectedServices.join(', ')}] within ${timeoutMs}ms` +
      (lastSeen ? ` — last seen: ${JSON.stringify(lastSeen)}` : ' — trace never appeared at all'),
  );
}

let ingestProcess: ChildProcess | undefined;
let tracingHandle: TracingHandle | undefined;

describe('cross-language trace propagation', () => {
  beforeAll(async () => {
    const build = spawnSync('go', ['build', '-o', INGEST_BIN, './cmd/ingest'], { cwd: INGEST_DIR });
    if (build.status !== 0) {
      throw new Error(`go build failed:\n${build.stderr.toString()}`);
    }

    ingestProcess = spawn(INGEST_BIN, [], {
      cwd: INGEST_DIR,
      env: { ...process.env, INGEST_ADDR: ':18101', OTEL_EXPORTER_OTLP_ENDPOINT: 'localhost:4317' },
    });
    ingestProcess.on('error', (err) => {
      throw new Error(`failed to start ingest binary: ${err.message}`);
    });

    tracingHandle = startTracing({ serviceName: SERVICE_NAME });

    await waitForHealthy(INGEST_URL, 10_000);
  });

  afterAll(async () => {
    ingestProcess?.kill();
    if (tracingHandle) await tracingHandle.shutdown();
  });

  it('T1: one trace spans the TypeScript caller and the Go ingest service', async () => {
    const tracer = trace.getTracer(SERVICE_NAME);
    const span = tracer.startSpan('api.synthetic_event_sent');
    const traceId = span.spanContext().traceId;
    const ctxWithSpan = trace.setSpan(context.active(), span);

    // UndiciInstrumentation (patches Node's fetch) injects the W3C
    // traceparent header from the active context automatically — nothing
    // here constructs it by hand.
    const response = await context.with(ctxWithSpan, () =>
      fetch(`${INGEST_URL}/internal/synthetic-event`, { method: 'POST' }),
    );
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { traceId: string };
    span.end();

    // Direct proof the traceparent header crossed the wire: the Go span
    // reports the SAME trace id, not a disconnected one of its own.
    expect(body.traceId).toBe(traceId);

    // Flush before polling Jaeger, so this test doesn't race the SDK's
    // own batch export interval.
    await tracingHandle!.shutdown();
    tracingHandle = undefined;

    const jaegerTrace = await waitForJaegerTrace(traceId, [SERVICE_NAME, 'sentinel-ingest'], 20_000);
    const serviceNames = new Set(Object.values(jaegerTrace.processes).map((p) => p.serviceName));
    expect(serviceNames.has(SERVICE_NAME)).toBe(true);
    expect(serviceNames.has('sentinel-ingest')).toBe(true);
  });
});
