/**
 * P1-11 T1: "Induced connector stall produces a lag metric increase and
 * fires the alert" — the first half verified here, against the real
 * otel-collector + Prometheus the dev stack provides, through a REAL
 * running `ingest` binary (not a mock meter). The second half — the
 * Grafana alert rule provisioned at
 * infra/docker/grafana-provisioning/alerting/ingest-lag.yml actually
 * firing — cannot be proven by waiting out the real 5-minute threshold in
 * a test suite; see that file's own comment for the threshold's reasoning,
 * and docs/architecture/overview.md's PR notes for how the rule's
 * provisioning itself is verified (loaded, valid, evaluating) without a
 * literal 5-minute wait.
 *
 * Needs: `pnpm dev:stack` running (otel-collector + Prometheus) and a Go
 * toolchain on PATH to build services/ingest.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const INGEST_DIR = path.resolve(import.meta.dirname, '../../../../services/ingest');
const INGEST_BIN = path.join(INGEST_DIR, process.platform === 'win32' ? 'ingest-lag-test.exe' : 'ingest-lag-test');
const INGEST_URL = 'http://127.0.0.1:18105';
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

/** Reads the current numeric value of a Prometheus instant query, or null
 * if the series doesn't exist yet. */
async function fetchGaugeValue(query: string): Promise<number | null> {
  const res = await fetch(`${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`);
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: { result?: Array<{ value: [number, string] }> } };
  const sample = body.data?.result?.[0];
  if (!sample) return null;
  return Number.parseFloat(sample.value[1]);
}

/** Polls until the series first appears, rather than a fixed sleep — same
 * reasoning as golden-signal-metrics.integration.test.ts's waitForMetric:
 * the collector batches on its own 5s export interval and Prometheus only
 * scrapes every 10s (prometheus.yml), so the real delay varies run to run. */
async function waitForFirstValue(query: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fetchGaugeValue(query);
    if (value !== null) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`metric ${query} did not appear in Prometheus within ${timeoutMs}ms`);
}

let ingestProcess: ChildProcess | undefined;

describe('ingest lag metric (P1-11 T1)', () => {
  beforeAll(async () => {
    const build = spawnSync('go', ['build', '-o', INGEST_BIN, './cmd/ingest'], { cwd: INGEST_DIR });
    if (build.status !== 0) {
      throw new Error(`go build failed:\n${build.stderr.toString()}`);
    }

    ingestProcess = spawn(INGEST_BIN, [], {
      cwd: INGEST_DIR,
      env: {
        ...process.env,
        INGEST_ADDR: ':18105',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'localhost:4317',
        // The real induced stall (T1's own requirement) — a connector
        // registered at boot whose Fetch never returns on its own. See
        // main.go's own comment on why this is env-gated at boot rather
        // than triggered over HTTP like P0-10's synthetic-event endpoint.
        INGEST_SYNTHETIC_STALLED_CONNECTOR: '1',
      },
    });
    ingestProcess.on('error', (err) => {
      throw new Error(`failed to start ingest binary: ${err.message}`);
    });

    await waitForHealthy(INGEST_URL, 15_000);
  });

  afterAll(() => {
    ingestProcess?.kill();
  });

  it(
    'T1: a connector that never completes a cycle shows a rising ingest lag metric',
    async () => {
      const query = 'connector_ingest_lag_seconds{connector_id="synthetic-stalled"}';

      // First reading: the gauge exists (the lag-reporting loop ran at
      // least once and the value made it through the real OTLP pipeline
      // to Prometheus) and is non-negative — go/sentinelconnector's
      // computeLag never returns a negative duration.
      const first = await waitForFirstValue(query, 30_000);
      expect(first).toBeGreaterThanOrEqual(0);

      // Real wall-clock wait, deliberately short (not the real 5-minute
      // alert threshold) — long enough for at least one more OTel export
      // (5s) and Prometheus scrape (10s) cycle to land a second, larger
      // reading, which is all T1 actually requires: the metric must be
      // rising for a connector that never succeeds, not stuck or reset.
      await new Promise((r) => setTimeout(r, 20_000));

      const second = await fetchGaugeValue(query);
      expect(second).not.toBeNull();
      expect(second!).toBeGreaterThan(first);
      // Loose lower bound, not an exact one — real scheduling jitter
      // across the scheduler's 10s lag-report tick, the SDK's 5s export
      // interval and Prometheus's 10s scrape means "increased by roughly
      // 20s" is the honest claim, not "increased by exactly 20.000s".
      expect(second! - first).toBeGreaterThanOrEqual(10);
    },
    60_000,
  );
});
