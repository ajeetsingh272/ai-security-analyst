/**
 * P4-06: real Postgres (`llm_usage`) + real Prometheus, verifying
 * `recordUsage` writes a durable row AND increments a real,
 * scrapeable OTel counter in the same call — the same "query the real
 * backend, don't trust the call site" discipline P4-04's own
 * grounding-metrics.integration.test.ts already established for
 * analyst_grounding_rejections_total.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import pg, { type Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createMeter } from '@sentinel/observability';
import { withTenantContext, LlmUsageRepository } from '@sentinel/db';
import { recordUsage } from '../cost-budget.js';
import type { PriceTable } from '../pricing.js';

const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? 'http://localhost:9090';
const pool: Pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel' });

async function asAdmin<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE sentinel_app');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function createTenantAndCase(): Promise<{ tenantId: string; caseId: string }> {
  const tenantId = await asAdmin(async (c) => {
    const { rows } = await c.query<{ id: string }>(`INSERT INTO tenants (name, plan) VALUES ($1, 'trial') RETURNING id`, [
      `P4-06 cost probe ${Date.now()}`,
    ]);
    return rows[0]!.id;
  });
  const caseId = await asAdmin(async (c) => {
    await c.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count, score)
       VALUES ($1, 'critical', 'P4-06 probe case', now(), 1, 50) RETURNING id`,
      [tenantId],
    );
    return rows[0]!.id;
  });
  return { tenantId, caseId };
}

async function deleteTenant(tenantId: string): Promise<void> {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
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

const PRICES: PriceTable = {
  'test-model': { inputPerMillion: 10, outputPerMillion: 20, cacheWritePerMillion: 12, cacheReadPerMillion: 1 },
};

const meterHandle = createMeter({ serviceName: 'sentinel-analyst-test' });
const costMetric = meterHandle.meter.createCounter('analyst.llm.cost_usd');

afterAll(async () => {
  await pool.end();
  await meterHandle.shutdown();
});

describe('LLM cost recording', () => {
  it('AC1/AC5: recordUsage writes a durable Postgres row AND a real, scrapeable Prometheus metric', async () => {
    const { tenantId, caseId } = await createTenantAndCase();
    try {
      const costUsd = await recordUsage(
        pool,
        tenantId,
        caseId,
        'test-model',
        'investigation',
        { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        PRICES,
        costMetric,
      );
      expect(costUsd).toBeCloseTo(10, 6); // 1M input tokens @ $10/M

      const spent = await withTenantContext(tenantId, () => new LlmUsageRepository(pool).dailySpendUsd(new Date()));
      expect(spent).toBeCloseTo(10, 6);

      const value = await waitForPrometheusValue(`analyst_llm_cost_usd_total{tenant_id="${tenantId}"}`, 15_000);
      expect(value).toBeCloseTo(10, 1);
    } finally {
      await deleteTenant(tenantId);
    }
  });
});
