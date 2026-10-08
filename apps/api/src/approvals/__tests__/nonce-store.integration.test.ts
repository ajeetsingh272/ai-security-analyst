/**
 * P5-03/ADR-0007 T1/T6 against real Postgres (and, for the happy path,
 * real Redis). T6 specifically: Redis unavailability must still
 * enforce single use via the Postgres uniqueness constraint — proven
 * here with a Redis client stand-in whose `set` always throws (a
 * genuine "Redis unreachable" from this store's point of view), not by
 * pausing a real container — deterministic and fast, and the thing
 * actually under test (ApprovalNonceRepository's own
 * `ON CONFLICT DO NOTHING` enforcement) is still exercised against the
 * real database either way.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RedisClientType } from 'redis';
import { createClient } from 'redis';
import pg, { type PoolClient } from 'pg';
import type { ApprovalTokenPayload } from '@sentinel/approval-tokens';
import { RedisPostgresNonceStore } from '../nonce-store.js';

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel' });
let redis: RedisClientType;
let tenantId: string;
let caseId: string;
let actionId: string;

async function asAdmin<T>(fn: (client: PoolClient) => Promise<T>, scopedTenantId?: string): Promise<T> {
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

function payloadFor(overrides: Partial<ApprovalTokenPayload> = {}): ApprovalTokenPayload {
  return {
    caseId,
    actionId,
    tenantId,
    approverId: 'approver-1',
    nonce: randomUUID(),
    exp: Math.floor(Date.now() / 1000) + 900,
    ...overrides,
  };
}

/** A Redis client stand-in that fails every call — simulates Redis
 * being genuinely unreachable, not merely "the key isn't set." */
const unreachableRedis = { set: async () => { throw new Error('ECONNREFUSED (simulated)'); } } as unknown as RedisClientType;

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();

  const tenantResult = await asAdmin((c) => c.query<{ id: string }>(`INSERT INTO tenants (name, plan) VALUES ('P5-03 nonce store probe', 'trial') RETURNING id`));
  tenantId = tenantResult.rows[0]!.id;
  const caseResult = await asAdmin(
    (c) => c.query<{ id: string }>(`INSERT INTO cases (tenant_id, severity, title, window_start) VALUES ($1, 'critical', 'probe case', now()) RETURNING id`, [tenantId]),
    tenantId,
  );
  caseId = caseResult.rows[0]!.id;
  const actionResult = await asAdmin(
    (c) => c.query<{ id: string }>(`INSERT INTO actions (tenant_id, case_id, playbook, target, blast_radius) VALUES ($1, $2, 'revoke_sessions', '{}'::jsonb, 'single_user') RETURNING id`, [
      tenantId,
      caseId,
    ]),
    tenantId,
  );
  actionId = actionResult.rows[0]!.id;
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  await redis.quit();
  await pool.end();
});

describe('RedisPostgresNonceStore', () => {
  it('T1: burns a nonce once via Redis, and a replay is rejected without touching Postgres twice', async () => {
    const store = new RedisPostgresNonceStore(redis, pool);
    const payload = payloadFor();

    expect(await store.burn(payload)).toBe(true);
    expect(await store.burn(payload)).toBe(false);
  });

  it('T6: Redis unavailable still enforces single use via the Postgres fallback', async () => {
    const store = new RedisPostgresNonceStore(unreachableRedis, pool);
    const payload = payloadFor();

    expect(await store.burn(payload)).toBe(true);
    expect(await store.burn(payload)).toBe(false);

    const { rows } = await asAdmin((c) => c.query('SELECT 1 FROM approval_nonces WHERE nonce = $1', [payload.nonce]), tenantId);
    expect(rows).toHaveLength(1);
  });

  it('a nonce burned once via real Redis is ALSO durably persisted in Postgres', async () => {
    const store = new RedisPostgresNonceStore(redis, pool);
    const payload = payloadFor();
    await store.burn(payload);

    const { rows } = await asAdmin((c) => c.query('SELECT 1 FROM approval_nonces WHERE nonce = $1', [payload.nonce]), tenantId);
    expect(rows).toHaveLength(1);
  });
});
