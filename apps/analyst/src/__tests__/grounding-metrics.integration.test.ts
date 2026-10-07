/**
 * P4-04 T6 — the grounding rejection-rate metric, exported for real
 * through the exact OTel -> otel-collector -> Prometheus pipeline this
 * dev stack runs (createMeter, packages/observability), verified by
 * actually querying Prometheus's own HTTP API afterward rather than
 * trusting that `Counter.add()` was called — the identical discipline
 * worker.integration.test.ts's own `waitForSpans` already applies to
 * Jaeger for tracing.
 *
 * The Anthropic call itself is still faked (no real ANTHROPIC_API_KEY in
 * this sandbox); real ClickHouse is used so the rejection is a REAL
 * grounding failure (a cited event_id that genuinely does not exist for
 * this tenant), not a simulated one — the one thing P4-04 says must
 * never be a model self-check.
 *
 * Requires: pnpm dev:stack.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { createMeter } from '@sentinel/observability';
import { createTenantScopedClickHouseClient } from '../clickhouse.js';
import { AnthropicInvestigationModel, GroundingFailedError } from '../investigation-model.js';

const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? 'http://localhost:9090';

function finalTextResponse(text: string): Anthropic.Message {
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 } as never,
  } as unknown as Anthropic.Message;
}

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

const ch = createTenantScopedClickHouseClient(process.env.CLICKHOUSE_URL ?? 'http://localhost:8123');
const meterHandle = createMeter({ serviceName: 'sentinel-analyst-test' });
const groundingMetrics = {
  attempts: meterHandle.meter.createCounter('analyst.grounding.attempts'),
  rejections: meterHandle.meter.createCounter('analyst.grounding.rejections'),
};

afterAll(async () => {
  await ch.close();
  await meterHandle.shutdown();
});

describe('grounding rejection-rate metric', () => {
  it('T6: a real grounding rejection increments analyst_grounding_rejections_total, scrapeable from Prometheus', async () => {
    const tenantId = randomUUID();
    const badVerdictText = JSON.stringify({
      severity: 'high',
      title: 'Unverifiable',
      claims: [{ text: 'A claim citing an event that was never ingested', evidenceRef: [`evt_never_real_${randomUUID()}`] }],
      attackChain: [],
      recommendedActions: [],
    });
    const create = async () => finalTextResponse(badVerdictText);
    const fakeClient = { messages: { create } } as unknown as Anthropic;

    const model = new AnthropicInvestigationModel({
      apiKey: 'unused',
      model: 'test-model',
      client: fakeClient,
      tools: { ch, pool: null as never, logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never },
      groundingMetrics,
    });

    await expect(
      model.investigate({ caseId: 'probe-case', tenantId, windowStart: new Date(Date.now() - 86_400_000).toISOString(), windowEnd: null }),
    ).rejects.toThrow(GroundingFailedError);

    const value = await waitForPrometheusValue(`analyst_grounding_rejections_total{tenant_id="${tenantId}"}`, 20_000);
    expect(value).toBeGreaterThanOrEqual(1);

    const attemptsValue = await waitForPrometheusValue(`analyst_grounding_attempts_total{tenant_id="${tenantId}"}`, 5_000);
    expect(attemptsValue).toBeGreaterThanOrEqual(1);
  });
});
