/**
 * P4-02 T1/T2 — the four investigation tools against real ClickHouse and
 * real Postgres. Seeding uses the ClickHouse default/admin user (the one
 * every migration script in this repo already uses); the tools
 * themselves are exercised exactly as they run in production — ClickHouse
 * reads go through `sentinel_query_user` with the real
 * `tenant_isolation` ROW POLICY (db/clickhouse/0002_hot_cold_tier_and_
 * row_policy.sql) in effect, Postgres reads go through the real
 * `sentinel_app` RLS policy (packages/db's own TenantScopedRepository).
 *
 * T2 proves the SAME property scripts/verify-setup.sh's own P1-06 T2
 * already proves for raw curl queries, now for this tool surface's own
 * code path: two tenants share an entityId/caseId-shaped value, and each
 * tenant's own tool call sees only its own rows.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg, { type Pool } from 'pg';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { createLogger } from '@sentinel/observability';
import { createTenantScopedClickHouseClient } from '../clickhouse.js';
import { queryEvents } from '../tools/query-events.js';
import { getEntityBaseline, MIN_OBSERVATIONS } from '../tools/entity-baseline.js';
import { lookupThreatIntel } from '../tools/threat-intel.js';
import { getCaseHistory } from '../tools/case-history.js';
import { isToolError } from '../tools/types.js';

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const pool: Pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel' });
const ch: ClickHouseClient = createTenantScopedClickHouseClient(CLICKHOUSE_URL);
/** Seeding needs INSERT, which `sentinel_query_user` is never granted
 * (0002's own GRANT SELECT-only) — the same reason every migration
 * script in this repo connects as the default user instead. */
const chAdmin: ClickHouseClient = createClient({ url: CLICKHOUSE_URL, database: 'sentinel' });
const logger = createLogger({ service: 'sentinel-analyst-test' });

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

async function createTenant(): Promise<string> {
  return asAdmin(async (c) => {
    const { rows } = await c.query<{ id: string }>(`INSERT INTO tenants (name, plan) VALUES ($1, 'trial') RETURNING id`, [
      `P4-02 tools probe ${Date.now()}-${randomUUID()}`,
    ]);
    return rows[0]!.id;
  });
}

async function createCase(tenantId: string): Promise<string> {
  return asAdmin(async (c) => {
    await c.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count, score)
       VALUES ($1, 'critical', 'P4-02 probe case', now(), 1, 50) RETURNING id`,
      [tenantId],
    );
    return rows[0]!.id;
  });
}

async function seedCaseSignalsAndTransitions(tenantId: string, caseId: string): Promise<void> {
  await asAdmin(async (c) => {
    await c.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    await c.query(
      `INSERT INTO case_signals (tenant_id, case_id, dedupe_key, signal_id, rule_id, entity_type, entity_id, severity, detected_at)
       VALUES ($1, $2, $3, 'sig-1', 'rule-1', 'user', 'probe-entity', 'critical', now())`,
      [tenantId, caseId, `dedupe-${randomUUID()}`],
    );
    await c.query(
      `INSERT INTO case_transitions (tenant_id, case_id, from_state, to_state, actor_type, actor_id, reason)
       VALUES ($1, $2, 'new', 'triaging', 'system', 'detector', 'escalated')`,
      [tenantId, caseId],
    );
  });
}

async function deleteTenant(tenantId: string): Promise<void> {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
}

async function seedEvents(tenantId: string, entityId: string, count: number): Promise<void> {
  const rows = Array.from({ length: count }, (_, i) => ({
    tenant_id: tenantId,
    event_id: `evt-${randomUUID()}-${i}`,
    time: new Date(Date.now() - i * 1000).toISOString().replace('T', ' ').replace('Z', ''),
    class_uid: 3002,
    category_uid: 3,
    activity_id: 1,
    severity_id: 1,
    actor_user_uid: entityId,
    target_uid: '',
    src_ip: '10.0.0.1',
    status_id: 1,
    message: `probe event ${i}`,
  }));
  await chAdmin.insert({ table: 'events', values: rows, format: 'JSONEachRow' });
}

async function seedBaseline(tenantId: string, entityId: string, observations: number, topValue: string): Promise<void> {
  // entity_baselines is an AggregatingMergeTree keyed on count/uniq/topK
  // aggregate STATES, not plain values — -State() functions produce the
  // exact binary state the real Recompute path (services/correlate/
  // internal/baseline/store.go) writes, so reading it back via
  // finalizeAggregation/topKMerge exercises the real column shape.
  await chAdmin.command({
    query: `
      INSERT INTO sentinel.entity_baselines (tenant_id, entity_id, metric, bucket, observations, distinct_values, value_counts)
      SELECT '${tenantId}', '${entityId}', 'country', today(), countState(), uniqState(x), topKState(10)(x)
      FROM (SELECT arrayJoin(arrayMap(i -> '${topValue}', range(${observations}))) AS x)
    `,
  });
  await chAdmin.command({ query: 'OPTIMIZE TABLE sentinel.entity_baselines FINAL' });
}

const cleanupTenants: string[] = [];

beforeAll(async () => {
  await chAdmin.command({ query: 'TRUNCATE TABLE IF EXISTS sentinel.events' });
  await chAdmin.command({ query: 'TRUNCATE TABLE IF EXISTS sentinel.entity_baselines' });
});

afterAll(async () => {
  for (const tenantId of cleanupTenants) await deleteTenant(tenantId).catch(() => {});
  await pool.end();
  await ch.close();
  await chAdmin.close();
});

describe('investigation tools — T1: correct results against seeded data', () => {
  it('query_events returns this entity\'s own events, newest first', async () => {
    const tenantId = await createTenant();
    cleanupTenants.push(tenantId);
    const entityId = `user-${randomUUID()}`;
    await seedEvents(tenantId, entityId, 3);

    const result = await queryEvents(ch, tenantId, { entityId }, logger);
    expect(isToolError(result)).toBe(false);
    if (!isToolError(result)) {
      expect(result.events).toHaveLength(3);
      expect(result.truncated).toBe(false);
      expect(result.events.every((e) => e.actor_user_uid === entityId)).toBe(true);
    }
  });

  it('query_events truncates with an explicit marker when there are more rows than the limit (AC3/T3)', async () => {
    const tenantId = await createTenant();
    cleanupTenants.push(tenantId);
    const entityId = `user-${randomUUID()}`;
    await seedEvents(tenantId, entityId, 5);

    const result = await queryEvents(ch, tenantId, { entityId, limit: 3 }, logger);
    expect(isToolError(result)).toBe(false);
    if (!isToolError(result)) {
      expect(result.events).toHaveLength(3);
      expect(result.truncated).toBe(true);
    }
  });

  it('get_entity_baseline reports a valid baseline once observations meet the floor', async () => {
    const tenantId = await createTenant();
    cleanupTenants.push(tenantId);
    const entityId = `user-${randomUUID()}`;
    await seedBaseline(tenantId, entityId, MIN_OBSERVATIONS + 5, 'IN');

    const result = await getEntityBaseline(ch, tenantId, { entityId, metric: 'country' }, logger);
    expect(isToolError(result)).toBe(false);
    if (!isToolError(result)) {
      expect(result.valid).toBe(true);
      expect(result.usualValues).toContain('IN');
    }
  });

  it('get_entity_baseline reports insufficient data below the observation floor', async () => {
    const tenantId = await createTenant();
    cleanupTenants.push(tenantId);
    const entityId = `user-${randomUUID()}`;
    await seedBaseline(tenantId, entityId, MIN_OBSERVATIONS - 5, 'IN');

    const result = await getEntityBaseline(ch, tenantId, { entityId, metric: 'country' }, logger);
    expect(isToolError(result)).toBe(false);
    if (!isToolError(result)) {
      expect(result.valid).toBe(false);
    }
  });

  it('lookup_threat_intel honestly reports no configured data source', async () => {
    const result = await lookupThreatIntel('tenant-irrelevant', { indicator: '1.2.3.4', indicatorType: 'ip' }, logger);
    expect(isToolError(result)).toBe(false);
    if (!isToolError(result)) {
      expect(result.configured).toBe(false);
    }
  });

  it('get_case_history returns this case\'s own signals and transitions', async () => {
    const tenantId = await createTenant();
    cleanupTenants.push(tenantId);
    const caseId = await createCase(tenantId);
    await seedCaseSignalsAndTransitions(tenantId, caseId);

    const result = await getCaseHistory(pool, tenantId, { caseId }, logger);
    expect(isToolError(result)).toBe(false);
    if (!isToolError(result)) {
      expect(result.case?.id).toBe(caseId);
      expect(result.signals).toHaveLength(1);
      expect(result.signals[0]?.entityId).toBe('probe-entity');
      expect(result.transitions).toHaveLength(1);
      expect(result.transitions[0]?.toState).toBe('triaging');
    }
  });
});

describe('investigation tools — T2: a tool call never sees another tenant\'s data', () => {
  it('query_events: two tenants sharing the same entityId each see only their own rows (ClickHouse row policy)', async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    cleanupTenants.push(tenantA, tenantB);
    const sharedEntityId = `shared-${randomUUID()}`;
    await seedEvents(tenantA, sharedEntityId, 2);
    await seedEvents(tenantB, sharedEntityId, 5);

    const asA = await queryEvents(ch, tenantA, { entityId: sharedEntityId }, logger);
    const asB = await queryEvents(ch, tenantB, { entityId: sharedEntityId }, logger);

    expect(isToolError(asA)).toBe(false);
    expect(isToolError(asB)).toBe(false);
    if (!isToolError(asA) && !isToolError(asB)) {
      expect(asA.events).toHaveLength(2);
      expect(asB.events).toHaveLength(5);
    }
  });

  it('get_case_history: tenant B asking about tenant A\'s own case id gets nothing back (Postgres RLS)', async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    cleanupTenants.push(tenantA, tenantB);
    const caseIdA = await createCase(tenantA);
    await seedCaseSignalsAndTransitions(tenantA, caseIdA);

    const asB = await getCaseHistory(pool, tenantB, { caseId: caseIdA }, logger);
    expect(isToolError(asB)).toBe(false);
    if (!isToolError(asB)) {
      expect(asB.case).toBeNull();
      expect(asB.signals).toHaveLength(0);
      expect(asB.transitions).toHaveLength(0);
    }

    const asA = await getCaseHistory(pool, tenantA, { caseId: caseIdA }, logger);
    expect(isToolError(asA)).toBe(false);
    if (!isToolError(asA)) {
      expect(asA.case?.id).toBe(caseIdA);
    }
  });
});
