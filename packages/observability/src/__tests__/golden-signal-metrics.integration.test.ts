/**
 * P0-10 T3: every expected golden-signal metric (request rate, errors,
 * duration — AC4) is present after a synthetic run, verified through
 * Prometheus's own query API rather than trusting that otel-collector
 * received and forwarded them correctly.
 *
 * Needs: `pnpm dev:stack` running (otel-collector + Prometheus) and a Go
 * toolchain on PATH to build services/ingest.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const INGEST_DIR = path.resolve(import.meta.dirname, '../../../../services/ingest');
const INGEST_BIN = path.join(INGEST_DIR, process.platform === 'win32' ? 'ingest-test.exe' : 'ingest-test');
const INGEST_URL = 'http://127.0.0.1:18103';
const PROMETHEUS_URL = 'http://localhost:9090';

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

/** Polls Prometheus's instant-query API until `metricName` has a sample
 * carrying the given label, rather than a fixed sleep — the otel-collector
 * batches on its own schedule and Prometheus only scrapes every 10s
 * (prometheus.yml), so the actual delay varies run to run. */
async function waitForMetric(metricName: string, label: [string, string], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const query = `${metricName}{${label[0]}="${label[1]}"}`;
  while (Date.now() < deadline) {
    const res = await fetch(`${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`);
    if (res.ok) {
      const body = (await res.json()) as { data?: { result?: unknown[] } };
      if (body.data?.result && body.data.result.length > 0) return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`metric ${query} did not appear in Prometheus within ${timeoutMs}ms`);
}

let ingestProcess: ChildProcess | undefined;

describe('golden-signal metrics', () => {
  beforeAll(async () => {
    const build = spawnSync('go', ['build', '-o', INGEST_BIN, './cmd/ingest'], { cwd: INGEST_DIR });
    if (build.status !== 0) {
      throw new Error(`go build failed:\n${build.stderr.toString()}`);
    }

    ingestProcess = spawn(INGEST_BIN, [], {
      cwd: INGEST_DIR,
      env: { ...process.env, INGEST_ADDR: ':18103', OTEL_EXPORTER_OTLP_ENDPOINT: 'localhost:4317' },
    });
    ingestProcess.on('error', (err) => {
      throw new Error(`failed to start ingest binary: ${err.message}`);
    });

    await waitForHealthy(INGEST_URL, 10_000);
  });

  afterAll(() => {
    ingestProcess?.kill();
  });

  it('T3: request_count, error_count and duration all appear after a synthetic run', async () => {
    await fetch(`${INGEST_URL}/internal/synthetic-event`, { method: 'POST' });
    await fetch(`${INGEST_URL}/internal/synthetic-event`, { method: 'POST' });
    await fetch(`${INGEST_URL}/internal/synthetic-error`, { method: 'POST' });

    // otel-collector's prometheus exporter is what actually names these —
    // dots become underscores, counters get a `_total` suffix, and the
    // histogram's declared "ms" unit becomes `_milliseconds` with the usual
    // `_bucket`/`_sum`/`_count` trio. Confirmed empirically against a live
    // run rather than assumed from the OTel spec, since the exact naming
    // is the exporter's translation, not something this repo controls.
    await Promise.all([
      waitForMetric('http_server_request_count_total', ['http_route', '/internal/synthetic-event'], 20_000),
      waitForMetric('http_server_error_count_total', ['http_route', '/internal/synthetic-error'], 20_000),
      waitForMetric('http_server_duration_milliseconds_count', ['http_route', '/internal/synthetic-event'], 20_000),
    ]);
  });
});
