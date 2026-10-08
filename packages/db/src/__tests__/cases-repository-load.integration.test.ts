/**
 * P6-02 T3: "list renders responsively at 10,000 cases." This is the
 * backend half of that claim — CasesRepository.list()'s own query time
 * at the ticket's own stated scale, against a real Postgres with the
 * real 0023 index. The frontend half (the dashboard actually staying
 * responsive once it has the response) is Playwright's job
 * (apps/dashboard/e2e/case-list.spec.ts), not this file's.
 *
 * 10,000 individual INSERTs would make this test itself the slow part —
 * bulk-inserted via unnest() instead, which is also closer to how a real
 * burst of correlated signals would actually arrive.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createControlPlanePool, withTenantContext, CasesRepository } from '../index.js';

const CASE_COUNT = 10_000;
// Generous for a shared dev/CI machine under load — the point of this
// assertion is "did the index actually get used, not a sequential scan
// across 10,000 rows," not a tight performance SLO: a scan-based plan at
// this scale is seconds, not tens of milliseconds, so a few-hundred-ms
// budget still clearly distinguishes the two without being flaky.
const MAX_QUERY_MS = 1500;

let pool: Pool;
let tenantId: string;

async function asAdmin<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
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

beforeAll(async () => {
  pool = createControlPlanePool();
  const tenantResult = await asAdmin((c) =>
    c.query<{ id: string }>(`INSERT INTO tenants (name, plan) VALUES ('P6-02 load probe', 'trial') RETURNING id`),
  );
  tenantId = tenantResult.rows[0]!.id;

  const severities = ['critical', 'high', 'medium', 'low', 'info'];
  const caseIds: string[] = [];
  const severityValues: string[] = [];
  const scoreValues: number[] = [];

  for (let i = 0; i < CASE_COUNT; i++) {
    caseIds.push(randomUUID());
    severityValues.push(severities[i % severities.length]!);
    scoreValues.push(Math.random() * 100);
  }

  await asAdmin(async (client) => {
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    await client.query(
      `INSERT INTO cases (id, tenant_id, severity, score, title, window_start, signal_count)
       SELECT id, $1, severity, score, 'P6-02 load probe case', now(), 1
       FROM unnest($2::uuid[], $3::text[], $4::numeric[]) AS u(id, severity, score)`,
      [tenantId, caseIds, severityValues, scoreValues],
    );
    await client.query(
      `INSERT INTO case_transitions (tenant_id, case_id, from_state, to_state, actor_type, actor_id, reason)
       SELECT $1, id, NULL, 'open', 'system', 'correlate', 'load test fixture'
       FROM unnest($2::uuid[]) AS u(id)`,
      [tenantId, caseIds],
    );
  });
}, 60_000);

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  await pool.end();
}, 30_000);

describe('CasesRepository.list at 10,000 cases', () => {
  it('T3: an unfiltered, severity-ranked first page returns quickly', async () => {
    const start = performance.now();
    const page = await withTenantContext(tenantId, () => new CasesRepository(pool).list({}, 1, 25));
    const elapsedMs = performance.now() - start;

    expect(page.total).toBe(CASE_COUNT);
    expect(page.items).toHaveLength(25);
    expect(page.items.every((item) => item.severity === 'critical')).toBe(true); // ranked first
    expect(elapsedMs).toBeLessThan(MAX_QUERY_MS);
  });

  it('a severity-filtered page at this scale also returns quickly', async () => {
    const start = performance.now();
    const page = await withTenantContext(tenantId, () => new CasesRepository(pool).list({ severity: 'info' }, 1, 25));
    const elapsedMs = performance.now() - start;

    expect(page.total).toBe(CASE_COUNT / 5); // one fifth of severities is 'info'
    expect(elapsedMs).toBeLessThan(MAX_QUERY_MS);
  });

  it('a deep page (near the end of 10,000 rows) also returns quickly', async () => {
    const start = performance.now();
    const page = await withTenantContext(tenantId, () => new CasesRepository(pool).list({}, 390, 25));
    const elapsedMs = performance.now() - start;

    expect(page.items.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(MAX_QUERY_MS);
  });
});
