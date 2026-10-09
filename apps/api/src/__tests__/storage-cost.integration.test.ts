/**
 * P7-05 AC5 — measureTenantStorageCost against the real dev-stack
 * ClickHouse's own system.parts. Deliberately does NOT assert an exact
 * dollar figure: system.parts' compressed-byte counts depend on the
 * server's own merge/compression state at query time, which this test
 * does not control — see storage-cost.ts's own doc comment for why
 * this is a disclosed proportional ESTIMATE, not exact per-tenant
 * billing. What this proves for real: the query runs against the live
 * schema (system.parts' real column names, sentinel.events' real
 * tenant_id/time columns), returns well-formed, non-negative numbers,
 * and a tenant with zero cold-tier rows of its own is correctly
 * estimated at zero cold cost regardless of how much cold data OTHER
 * tenants have.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { createAdminClickHouseClient } from '../clickhouse.js';
import { measureTenantStorageCost } from '../storage-cost.js';

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel' });
const chAdmin: ClickHouseClient = createClient({ url: CLICKHOUSE_URL, database: 'sentinel' });

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

describe('measureTenantStorageCost (T: a real storage-cost estimate against real ClickHouse)', () => {
  let tenantId: string;

  beforeAll(async () => {
    tenantId = randomUUID();
    await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [tenantId, 'P7-05 storage cost probe tenant', 'trial']));

    const rows = Array.from({ length: 20 }, (_, i) => ({
      tenant_id: tenantId,
      event_id: `evt-cost-${randomUUID()}-${i}`,
      time: new Date(Date.now() - i * 1000).toISOString().replace('T', ' ').replace('Z', ''),
      class_uid: 3002,
      category_uid: 3,
      activity_id: 1,
      severity_id: 1,
      actor_user_uid: 'probe@example.com',
      target_uid: '',
      src_ip: '203.0.113.9',
      status_id: 1,
      message: `storage cost probe event ${i}`,
    }));
    await chAdmin.insert({ table: 'events', values: rows, format: 'JSONEachRow' });
  });

  afterAll(async () => {
    await chAdmin.command({ query: 'ALTER TABLE sentinel.events DELETE WHERE tenant_id = {tenantId:UUID}', query_params: { tenantId }, clickhouse_settings: { mutations_sync: '1' } });
    await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  });

  it('a tenant with only recent (hot-tier) rows is estimated with zero cold cost and non-negative, finite hot cost', async () => {
    const adminClickHouse = createAdminClickHouseClient(CLICKHOUSE_URL);
    const cost = await measureTenantStorageCost(adminClickHouse, tenantId);

    expect(cost.coldGb).toBe(0);
    expect(cost.coldCostUsd).toBe(0);
    expect(cost.hotGb).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(cost.hotGb)).toBe(true);
    expect(Number.isFinite(cost.hotCostUsd)).toBe(true);
    expect(cost.totalCostUsd).toBeCloseTo(cost.hotCostUsd + cost.coldCostUsd, 10);
  });

  it('a tenant with zero rows at all is estimated at exactly zero, not NaN from a 0/0 division', async () => {
    const emptyTenantId = randomUUID();
    await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [emptyTenantId, 'P7-05 empty storage cost probe tenant', 'trial']));
    try {
      const adminClickHouse = createAdminClickHouseClient(CLICKHOUSE_URL);
      const cost = await measureTenantStorageCost(adminClickHouse, emptyTenantId);
      expect(cost).toEqual({ hotGb: 0, coldGb: 0, hotCostUsd: 0, coldCostUsd: 0, totalCostUsd: 0 });
    } finally {
      await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [emptyTenantId]));
    }
  });
});
