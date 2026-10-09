/**
 * P7-05 AC3/T3 — runRetentionSweep against the real dev-stack Postgres
 * and ClickHouse. Proves two things that cannot be proven from reading
 * the code alone: a tenant's own plan.retentionDays cutoff actually
 * removes rows older than it, and a tenant on a LONGER-retention plan
 * is untouched by the same sweep run — this is a per-tenant cutoff,
 * not one shared value applied to everyone.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { createAdminClickHouseClient } from '../clickhouse.js';
import { runRetentionSweep } from '../retention-sweep.js';

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel' });
/** Seeding needs INSERT, which `sentinel_query_user` is never granted —
 * same reason apps/analyst's own tools.integration.test.ts and this
 * file's own target, retention-sweep.ts, both connect as the default
 * user instead. */
const chAdmin: ClickHouseClient = createClient({ url: CLICKHOUSE_URL, database: 'sentinel' });
const testLogger = { info: () => {}, error: () => {} };

async function asAdmin<T>(fn: (client: pg.PoolClient) => Promise<T>, scopedTenantId?: string): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE sentinel_app');
    if (scopedTenantId) await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', scopedTenantId]);
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

async function makeTenant(plan: string, label: string): Promise<string> {
  const tenantId = randomUUID();
  await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [tenantId, `P7-05 ${label}`, plan]));
  return tenantId;
}

async function seedEvent(tenantId: string, eventId: string, time: Date): Promise<void> {
  await chAdmin.insert({
    table: 'events',
    values: [{
      tenant_id: tenantId,
      event_id: eventId,
      time: time.toISOString().replace('T', ' ').replace('Z', ''),
      class_uid: 3002,
      category_uid: 3,
      activity_id: 1,
      severity_id: 1,
      actor_user_uid: 'probe@example.com',
      target_uid: '',
      src_ip: '203.0.113.9',
      status_id: 1,
      message: 'retention sweep probe event',
    }],
    format: 'JSONEachRow',
  });
}

async function countEvents(tenantId: string): Promise<number> {
  const result = await chAdmin.query({
    query: 'SELECT count() AS c FROM sentinel.events WHERE tenant_id = {tenantId:UUID}',
    query_params: { tenantId },
    format: 'JSONEachRow',
  });
  const rows = await result.json<{ c: string }>();
  return Number(rows[0]?.c ?? 0);
}

describe('runRetentionSweep (T3: per-plan retention enforcement)', () => {
  let shortTenantId: string; // trial: retentionDays = 30
  let longTenantId: string; // msp: retentionDays = 365
  const agedBeyondShort = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); // 40 days — past trial's 30, well within msp's 365
  const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);

  beforeAll(async () => {
    shortTenantId = await makeTenant('trial', 'short-retention tenant');
    longTenantId = await makeTenant('msp', 'long-retention tenant');

    await Promise.all([
      seedEvent(shortTenantId, `evt-aged-${randomUUID()}`, agedBeyondShort),
      seedEvent(shortTenantId, `evt-recent-${randomUUID()}`, recent),
      seedEvent(longTenantId, `evt-aged-${randomUUID()}`, agedBeyondShort),
      seedEvent(longTenantId, `evt-recent-${randomUUID()}`, recent),
    ]);
  });

  afterAll(async () => {
    for (const tenantId of [shortTenantId, longTenantId]) {
      await chAdmin.command({ query: 'ALTER TABLE sentinel.events DELETE WHERE tenant_id = {tenantId:UUID}', query_params: { tenantId }, clickhouse_settings: { mutations_sync: '1' } });
      await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
    }
  });

  it("deletes a trial tenant's events older than its own 30-day retention, keeps the recent one, and leaves an msp tenant's 40-day-old event untouched (its own plan allows 365 days)", async () => {
    expect(await countEvents(shortTenantId)).toBe(2);
    expect(await countEvents(longTenantId)).toBe(2);

    const adminClickHouse = createAdminClickHouseClient(CLICKHOUSE_URL);
    await runRetentionSweep(pool, adminClickHouse, testLogger);

    expect(await countEvents(shortTenantId)).toBe(1);
    expect(await countEvents(longTenantId)).toBe(2);
  });
});
