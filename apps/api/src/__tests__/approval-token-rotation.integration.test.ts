/**
 * P5-11 AC2/T2: "token secret rotation is performed with no failed
 * approvals during the overlap," against real Postgres and Redis.
 * See docs/runbooks/approval-token-secret-rotation.md for the full
 * operator procedure this proves.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type RedisClientType } from 'redis';
import pg, { type PoolClient } from 'pg';
import { signApprovalToken } from '@sentinel/approval-tokens';
import { buildApp } from '../app.js';

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel' });
let redis: RedisClientType;
let tenantId: string;
let caseId: string;

const OLD_SECRET = 'rotation-test-old-secret';
const NEW_SECRET = 'rotation-test-new-secret';

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

async function createAction(): Promise<string> {
  const caseResult = await asAdmin(
    (c) => c.query<{ id: string }>(`INSERT INTO cases (tenant_id, severity, title, window_start) VALUES ($1, 'critical', 'rotation probe case', now()) RETURNING id`, [tenantId]),
    tenantId,
  );
  caseId = caseResult.rows[0]!.id;
  const actionResult = await asAdmin(
    (c) => c.query<{ id: string }>(`INSERT INTO actions (tenant_id, case_id, playbook, target, blast_radius) VALUES ($1, $2, 'revoke_sessions', '{}'::jsonb, 'single_user') RETURNING id`, [tenantId, caseId]),
    tenantId,
  );
  return actionResult.rows[0]!.id;
}

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();
  const tenantResult = await asAdmin((c) => c.query<{ id: string }>(`INSERT INTO tenants (name, plan) VALUES ('P5-11 rotation probe', 'trial') RETURNING id`));
  tenantId = tenantResult.rows[0]!.id;
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  await redis.quit();
  await pool.end();
});

describe('approval token secret rotation (overlapping validity)', () => {
  it('BEFORE rotation: only the current (soon-to-be-old) secret is configured — signing and verifying both use it', async () => {
    const app = await buildApp({ pool, redis, cookieSecure: false, approvalsConfig: { tokenSecret: OLD_SECRET } });
    try {
      const actionId = await createAction();
      const token = signApprovalToken({ caseId, actionId, tenantId, approverId: 'owner', nonce: randomUUID(), exp: Math.floor(Date.now() / 1000) + 900 }, OLD_SECRET);
      const res = await app.inject({ method: 'POST', url: `/approvals/${token}` });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('T2: DURING the overlap — a token signed under the OLD secret BEFORE rotation still approves successfully against the NEW config', async () => {
    // Minted before the operator rotates — exactly the "in-flight
    // 15-minute-lived token" scenario the runbook exists for.
    const actionId = await createAction();
    const tokenMintedBeforeRotation = signApprovalToken({ caseId, actionId, tenantId, approverId: 'owner', nonce: randomUUID(), exp: Math.floor(Date.now() / 1000) + 900 }, OLD_SECRET);

    // The operator has now deployed the new config: NEW_SECRET signs,
    // OLD_SECRET still verifies.
    const appDuringOverlap = await buildApp({ pool, redis, cookieSecure: false, approvalsConfig: { tokenSecret: NEW_SECRET, previousTokenSecret: OLD_SECRET } });
    try {
      const res = await appDuringOverlap.inject({ method: 'POST', url: `/approvals/${tokenMintedBeforeRotation}` });
      expect(res.statusCode).toBe(200); // not a failed approval
    } finally {
      await appDuringOverlap.close();
    }
  });

  it('a FRESH token, minted during the overlap, is signed under the NEW secret and verifies too', async () => {
    const actionId = await createAction();
    const appDuringOverlap = await buildApp({ pool, redis, cookieSecure: false, approvalsConfig: { tokenSecret: NEW_SECRET, previousTokenSecret: OLD_SECRET } });
    try {
      const freshToken = signApprovalToken({ caseId, actionId, tenantId, approverId: 'owner', nonce: randomUUID(), exp: Math.floor(Date.now() / 1000) + 900 }, NEW_SECRET);
      const res = await appDuringOverlap.inject({ method: 'POST', url: `/approvals/${freshToken}` });
      expect(res.statusCode).toBe(200);
    } finally {
      await appDuringOverlap.close();
    }
  });

  it('AFTER the overlap ends: a token signed under the now-retired OLD secret is correctly rejected once previousTokenSecret is removed', async () => {
    const actionId = await createAction();
    const tokenUnderRetiredSecret = signApprovalToken({ caseId, actionId, tenantId, approverId: 'owner', nonce: randomUUID(), exp: Math.floor(Date.now() / 1000) + 900 }, OLD_SECRET);

    const appAfterOverlap = await buildApp({ pool, redis, cookieSecure: false, approvalsConfig: { tokenSecret: NEW_SECRET } }); // no previousTokenSecret
    try {
      const res = await appAfterOverlap.inject({ method: 'POST', url: `/approvals/${tokenUnderRetiredSecret}` });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('bad_signature');
    } finally {
      await appAfterOverlap.close();
    }
  });
});
