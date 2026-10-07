/**
 * P4-08: executes one golden case (or the whole suite) through the
 * REAL analyst pipeline — real Postgres, real ClickHouse,
 * `TriageModel`/`InvestigationModel` injected so a real run (the
 * actual Anthropic-backed implementations, against a real
 * `ANTHROPIC_API_KEY`) and a fake-model run (this ticket's own unit
 * tests, T4's "a deliberately degraded prompt fails the suite") share
 * every line of seeding/scoring code — the harness itself is identical
 * either way; only which model implementation is wired differs.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ClickHouseClient } from '@clickhouse/client';
import type { CaseContext, InvestigationModel } from '../investigation-model.js';
import { GroundingFailedError } from '../investigation-model.js';
import type { TriageModel } from '../triage.js';
import type { GoldenCase } from './golden-cases.js';
import { type CaseResult, type CaseScore, type SuiteResult, scoreCase, aggregateResults } from './scoring.js';

export interface RunnerDeps {
  pool: Pool;
  /** The admin/default ClickHouse client — seeding needs INSERT, which
   * the tenant-scoped `sentinel_query_user` is never granted (the same
   * reason P4-02's own tools.integration.test.ts seeds this way). */
  chAdmin: ClickHouseClient;
  triageModel: TriageModel;
  investigationModel: InvestigationModel;
}

async function asAdmin<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
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

async function seedTenantAndCase(pool: Pool, goldenCase: GoldenCase): Promise<{ tenantId: string; caseId: string; windowStart: string }> {
  const tenantId = await asAdmin(pool, async (c) => {
    const { rows } = await c.query<{ id: string }>(`INSERT INTO tenants (name, plan) VALUES ($1, 'trial') RETURNING id`, [
      `P4-08 golden case ${goldenCase.id} ${randomUUID()}`,
    ]);
    return rows[0]!.id;
  });
  const { caseId, windowStart } = await asAdmin(pool, async (c) => {
    await c.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    const { rows } = await c.query<{ id: string; window_start: string }>(
      `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count, score)
       VALUES ($1, $2, $3, now() - interval '1 hour', 1, 50) RETURNING id, window_start`,
      [tenantId, goldenCase.seedSeverity, goldenCase.scenario],
    );
    return { caseId: rows[0]!.id, windowStart: rows[0]!.window_start };
  });
  return { tenantId, caseId, windowStart };
}

async function deleteTenant(pool: Pool, tenantId: string): Promise<void> {
  await asAdmin(pool, (c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
}

async function seedEvents(chAdmin: ClickHouseClient, tenantId: string, goldenCase: GoldenCase): Promise<void> {
  const rows = goldenCase.events.map((e, i) => ({
    tenant_id: tenantId,
    event_id: `golden-${goldenCase.id}-${i}-${randomUUID()}`,
    time: new Date(Date.now() - (goldenCase.events.length - i) * 60_000).toISOString().replace('T', ' ').replace('Z', ''),
    class_uid: 3002,
    category_uid: 3,
    activity_id: 1,
    severity_id: 1,
    actor_user_uid: e.entityId,
    target_uid: '',
    src_country: e.srcCountry ?? '',
    status_id: 1,
    message: e.message,
  }));
  await chAdmin.insert({ table: 'events', values: rows, format: 'JSONEachRow' });
}

async function seedBaseline(chAdmin: ClickHouseClient, tenantId: string, entityId: string): Promise<void> {
  // Enough observations to clear MinObservations (services/correlate/
  // internal/baseline/baseline.go's own floor of 20) so this entity's
  // behaviour reads as habitual, not merely low-severity.
  await chAdmin.command({
    query: `
      INSERT INTO sentinel.entity_baselines (tenant_id, entity_id, metric, bucket, observations, distinct_values, value_counts)
      SELECT '${tenantId}', '${entityId}', 'country', today(), countState(), uniqState(x), topKState(10)(x)
      FROM (SELECT arrayJoin(arrayMap(i -> 'usual-pattern', range(30))) AS x)
    `,
  });
  await chAdmin.command({ query: 'OPTIMIZE TABLE sentinel.entity_baselines FINAL' });
}

export async function runGoldenCase(goldenCase: GoldenCase, deps: RunnerDeps): Promise<CaseResult> {
  const { tenantId, caseId, windowStart } = await seedTenantAndCase(deps.pool, goldenCase);
  try {
    await seedEvents(deps.chAdmin, tenantId, goldenCase);
    if (goldenCase.seedBaseline) await seedBaseline(deps.chAdmin, tenantId, goldenCase.entityId);

    const ctx: CaseContext = { caseId, tenantId, severity: goldenCase.seedSeverity, title: goldenCase.scenario, windowStart, windowEnd: null };

    if (goldenCase.seedSeverity === 'critical') {
      return await investigate(goldenCase.id, 'bypass_critical', ctx, deps);
    }

    const decision = await deps.triageModel.triage(ctx);
    if (decision.decision === 'dismiss') {
      return { caseId: goldenCase.id, triageDisposition: 'dismiss' };
    }
    return await investigate(goldenCase.id, 'escalate', ctx, deps);
  } catch (err) {
    return { caseId: goldenCase.id, triageDisposition: 'escalate', error: err instanceof Error ? err.message : String(err) };
  } finally {
    await deleteTenant(deps.pool, tenantId);
  }
}

async function investigate(goldenCaseId: string, disposition: 'escalate' | 'bypass_critical', ctx: CaseContext, deps: RunnerDeps): Promise<CaseResult> {
  try {
    const verdict = await deps.investigationModel.investigate(ctx);
    return { caseId: goldenCaseId, triageDisposition: disposition, verdict, groundingPassed: true };
  } catch (err) {
    if (err instanceof GroundingFailedError) {
      return { caseId: goldenCaseId, triageDisposition: disposition, groundingPassed: false };
    }
    return { caseId: goldenCaseId, triageDisposition: disposition, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runGoldenSuite(cases: readonly GoldenCase[], deps: RunnerDeps): Promise<SuiteResult> {
  const scores: CaseScore[] = [];
  for (const goldenCase of cases) {
    const result = await runGoldenCase(goldenCase, deps);
    scores.push(scoreCase(goldenCase, result));
  }
  return aggregateResults(scores);
}
