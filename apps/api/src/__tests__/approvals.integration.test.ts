/**
 * P5-03/ADR-0007 T2/T3/T4/T5 — the full HTTP round trip against real
 * Postgres and Redis. T1/T6 (replay, Redis-down fallback) are proven
 * directly against RedisPostgresNonceStore in
 * approvals/__tests__/nonce-store.integration.test.ts; this file
 * proves everything the ROUTE itself is responsible for: binding
 * enforcement, expiry, tamper detection, and the GET/POST mutation
 * boundary.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import pg, { type PoolClient } from 'pg';
import { signApprovalToken, type ApprovalTokenPayload } from '@sentinel/approval-tokens';
import { buildApp } from '../app.js';

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel' });
let redis: RedisClientType;
let app: FastifyInstance;
let tenantId: string;
let caseId: string;
let actionId: string;
let otherCaseId: string;

const SECRET = 'test-approval-token-secret';

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

function tokenFor(overrides: Partial<ApprovalTokenPayload> = {}): string {
  return signApprovalToken(
    { caseId, actionId, tenantId, approverId: 'approver-1', nonce: randomUUID(), exp: Math.floor(Date.now() / 1000) + 900, ...overrides },
    SECRET,
  );
}

/** Tests that actually POST a successful approval must not share
 * `actionId` with each other (or with T5) — each needs its own
 * still-`proposed` row, since a prior test's successful approval would
 * otherwise make a LATER test's "approves the action" assertion see
 * `alreadyDecided: true` instead of `false`. */
async function createFreshAction(): Promise<string> {
  const result = await asAdmin(
    (c) => c.query<{ id: string }>(`INSERT INTO actions (tenant_id, case_id, playbook, target, blast_radius) VALUES ($1, $2, 'revoke_sessions', '{}'::jsonb, 'single_user') RETURNING id`, [
      tenantId,
      caseId,
    ]),
    tenantId,
  );
  return result.rows[0]!.id;
}

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();
  app = await buildApp({ pool, redis, cookieSecure: false, approvalsConfig: { tokenSecret: SECRET } });

  const tenantResult = await asAdmin((c) => c.query<{ id: string }>(`INSERT INTO tenants (name, plan) VALUES ('P5-03 approvals route probe', 'trial') RETURNING id`));
  tenantId = tenantResult.rows[0]!.id;

  const caseResult = await asAdmin(
    (c) => c.query<{ id: string }>(`INSERT INTO cases (tenant_id, severity, title, window_start) VALUES ($1, 'critical', 'probe case', now()) RETURNING id`, [tenantId]),
    tenantId,
  );
  caseId = caseResult.rows[0]!.id;
  const otherCaseResult = await asAdmin(
    (c) => c.query<{ id: string }>(`INSERT INTO cases (tenant_id, severity, title, window_start) VALUES ($1, 'critical', 'a DIFFERENT case', now()) RETURNING id`, [tenantId]),
    tenantId,
  );
  otherCaseId = otherCaseResult.rows[0]!.id;

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
  await app.close();
  await redis.quit();
  await pool.end();
});

describe('GET /approvals/:token (never mutates)', () => {
  it('returns what WOULD be approved for a valid token', async () => {
    const res = await app.inject({ method: 'GET', url: `/approvals/${tokenFor()}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ caseId, actionId, playbook: 'revoke_sessions', status: 'proposed', alreadyDecided: false });
  });

  it('T2: an expired token is rejected', async () => {
    const expired = tokenFor({ exp: Math.floor(Date.now() / 1000) - 1 });
    const res = await app.inject({ method: 'GET', url: `/approvals/${expired}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('expired');
  });

  it('T3: a tampered token fails signature verification', async () => {
    const signature = tokenFor().split('.')[1];
    const tamperedPayload = Buffer.from(
      JSON.stringify({ caseId, actionId: randomUUID(), tenantId, approverId: 'attacker', nonce: randomUUID(), exp: Math.floor(Date.now() / 1000) + 900 }),
      'utf8',
    ).toString('base64url');
    const res = await app.inject({ method: 'GET', url: `/approvals/${tamperedPayload}.${signature}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_signature');
  });

  it('T5: GET does not burn the nonce — a subsequent POST with the same token still succeeds', async () => {
    const freshActionId = await createFreshAction();
    const token = tokenFor({ actionId: freshActionId });
    const getRes = await app.inject({ method: 'GET', url: `/approvals/${token}` });
    expect(getRes.statusCode).toBe(200);

    const postRes = await app.inject({ method: 'POST', url: `/approvals/${token}` });
    expect(postRes.statusCode).toBe(200);
    expect(postRes.json()).toEqual({ ok: true, alreadyDecided: false });
  });

  it('does not require a session — a public, unauthenticated path', async () => {
    const res = await app.inject({ method: 'GET', url: `/approvals/${tokenFor()}` });
    expect(res.statusCode).not.toBe(401);
  });
});

describe('POST /approvals/:token', () => {
  it('T4: a token minted for a DIFFERENT case than the action it names is refused, not silently reattached', async () => {
    // actionId genuinely belongs to `caseId` — this token CLAIMS it
    // belongs to `otherCaseId` instead. The route must refuse this as
    // "not found," never approve the real action under the wrong case.
    const mismatchedToken = tokenFor({ caseId: otherCaseId });
    const res = await app.inject({ method: 'POST', url: `/approvals/${mismatchedToken}` });
    expect(res.statusCode).toBe(404);

    const { rows } = await asAdmin((c) => c.query('SELECT status FROM actions WHERE id = $1', [actionId]), tenantId);
    expect(rows[0]!.status).toBe('proposed');
  });

  it('approves the action and writes an audit entry', async () => {
    const freshActionId = await createFreshAction();
    const token = tokenFor({ actionId: freshActionId });
    const res = await app.inject({ method: 'POST', url: `/approvals/${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, alreadyDecided: false });

    const { rows } = await asAdmin((c) => c.query('SELECT status FROM actions WHERE id = $1', [freshActionId]), tenantId);
    expect(rows[0]!.status).toBe('approved');

    const audit = await asAdmin(
      (c) => c.query(`SELECT actor_type, actor_id FROM audit_log WHERE tenant_id = $1 AND action = 'approval_granted' AND subject_id = $2`, [tenantId, freshActionId]),
      tenantId,
    );
    expect(audit.rows).toEqual([{ actor_type: 'human', actor_id: 'approver-1' }]);
  });

  it('a rejected (expired) token still writes an audit entry', async () => {
    const freshActionId = await createFreshAction();
    const expired = tokenFor({ actionId: freshActionId, exp: Math.floor(Date.now() / 1000) - 1 });
    await app.inject({ method: 'POST', url: `/approvals/${expired}` });

    const { rows } = await asAdmin((c) => c.query(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'approval_rejected' AND subject_id = $2`, [tenantId, freshActionId]), tenantId);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('returns 503 rather than crashing when APPROVAL_TOKEN_SECRET is not configured', async () => {
    const unconfiguredApp = await buildApp({ pool, redis, cookieSecure: false, approvalsConfig: undefined });
    try {
      const res = await unconfiguredApp.inject({ method: 'GET', url: `/approvals/${tokenFor()}` });
      expect(res.statusCode).toBe(503);
    } finally {
      await unconfiguredApp.close();
    }
  });
});
