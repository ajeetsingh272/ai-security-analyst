/**
 * P4-10 T4 — "degraded mode is visible in the dashboard," verified by
 * actually querying Prometheus's own HTTP API for the real
 * `analyst_circuit_breaker_state` gauge after forcing the breaker
 * open, mirroring the same real-backend discipline
 * grounding-metrics.integration.test.ts already established for
 * `analyst_grounding_rejections_total`.
 *
 * Requires: pnpm dev:stack.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createMeter } from '@sentinel/observability';
import { CircuitBreaker, type CircuitState } from '../circuit-breaker.js';

const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? 'http://localhost:9090';

async function waitForPrometheusValue(query: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`);
    if (res.ok) {
      const body = (await res.json()) as { data?: { result?: Array<{ value: [number, string] }> } };
      const result = body.data?.result?.[0];
      if (result) return Number(result.value[1]);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`metric query never returned a value within ${timeoutMs}ms: ${query}`);
}

const SERVICE_NAME = `sentinel-analyst-test-cb-${Date.now()}`;
const meterHandle = createMeter({ serviceName: SERVICE_NAME });
const circuitBreaker = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 60_000 });
const CIRCUIT_STATE_VALUE: Record<CircuitState, number> = { closed: 0, half_open: 1, open: 2 };
meterHandle.meter
  .createObservableGauge('analyst.circuit_breaker.state')
  .addCallback((result) => result.observe(CIRCUIT_STATE_VALUE[circuitBreaker.getState()]));

afterAll(async () => {
  await meterHandle.shutdown();
});

describe('circuit breaker state metric', () => {
  it('T4: the circuit breaker state is a real, scrapeable Prometheus gauge — 0 when closed, 2 once forced open', async () => {
    // exported_job, not job — Prometheus's own scrape config already
    // sets `job` to the scrape target name, so the OTel collector's
    // Prometheus exporter renames the OTel resource's own service.name
    // attribute to exported_job to avoid colliding with it (the same
    // convention golden-signals.json's own dashboard already uses).
    const closedValue = await waitForPrometheusValue(`analyst_circuit_breaker_state{exported_job="${SERVICE_NAME}"}`, 20_000);
    expect(closedValue).toBe(0);

    circuitBreaker.onFailure(); // forces the breaker open
    expect(circuitBreaker.getState()).toBe('open');

    const openValue = await waitForPrometheusValue(`analyst_circuit_breaker_state{exported_job="${SERVICE_NAME}"} == 2`, 20_000);
    expect(openValue).toBe(2);
  });
});
