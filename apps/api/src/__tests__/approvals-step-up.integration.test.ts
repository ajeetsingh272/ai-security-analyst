/**
 * P5-04/ADR-0007 T1-T4 — step-up re-authentication for destructive
 * playbooks, against real Postgres and Redis. See
 * approvals.integration.test.ts for the P5-03 token-level behavior
 * (expiry, tamper, binding, replay) this ticket builds on unchanged for
 * any NON-destructive playbook.
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
import { hashPassword } from '../auth/password.js';

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel' });
let redis: RedisClientType;
let app: FastifyInstance;
let tenantId: string;
let caseId: string;
let approverId: string;

const SECRET = 'test-approval-token-secret';
const KNOWN_PASSWORD = 'correct horse battery staple';

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

async function createAction(playbook: string): Promise<string> {
  const result = await asAdmin(
    (c) => c.query<{ id: string }>(`INSERT INTO actions (tenant_id, case_id, playbook, target, blast_radius) VALUES ($1, $2, $3, '{}'::jsonb, 'single_user') RETURNING id`, [
      tenantId,
      caseId,
      playbook,
    ]),
    tenantId,
  );
  return result.rows[0]!.id;
}

function tokenFor(actionId: string, overrides: Partial<ApprovalTokenPayload> = {}): string {
  return signApprovalToken({ caseId, actionId, tenantId, approverId, nonce: randomUUID(), exp: Math.floor(Date.now() / 1000) + 900, ...overrides }, SECRET);
}

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();
  app = await buildApp({ pool, redis, cookieSecure: false, approvalsConfig: { tokenSecret: SECRET } });

  const tenantResult = await asAdmin((c) => c.query<{ id: string }>(`INSERT INTO tenants (name, plan) VALUES ('P5-04 step-up probe', 'trial') RETURNING id`));
  tenantId = tenantResult.rows[0]!.id;
  const caseResult = await asAdmin(
    (c) => c.query<{ id: string }>(`INSERT INTO cases (tenant_id, severity, title, window_start) VALUES ($1, 'critical', 'probe case', now()) RETURNING id`, [tenantId]),
    tenantId,
  );
  caseId = caseResult.rows[0]!.id;

  const passwordHash = await hashPassword(KNOWN_PASSWORD);
  const userResult = await asAdmin((c) => c.query<{ id: string }>(`INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`, [`step-up-probe-${randomUUID()}@example.com`, passwordHash]));
  approverId = userResult.rows[0]!.id;
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [approverId]));
  await app.close();
  await redis.quit();
  await pool.end();
});

describe('step-up authentication for destructive playbooks', () => {
  it('GET reports that this playbook requires step-up', async () => {
    const actionId = await createAction('disable_user');
    const res = await app.inject({ method: 'GET', url: `/approvals/${tokenFor(actionId)}` });
    expect(res.json()).toMatchObject({ requiresStepUp: true });
  });

  it('a non-destructive playbook does not require step-up', async () => {
    const actionId = await createAction('revoke_sessions');
    const res = await app.inject({ method: 'GET', url: `/approvals/${tokenFor(actionId)}` });
    expect(res.json()).toMatchObject({ requiresStepUp: false });
  });

  it('T1/T2: a destructive action with a valid token but NO step-up password is refused, via the raw API, no UI involved', async () => {
    const actionId = await createAction('disable_user');
    const res = await app.inject({ method: 'POST', url: `/approvals/${tokenFor(actionId)}` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('step_up_failed');

    const { rows } = await asAdmin((c) => c.query('SELECT status FROM actions WHERE id = $1', [actionId]), tenantId);
    expect(rows[0]!.status).toBe('proposed');
  });

  it('a destructive action with a valid token but the WRONG step-up password is refused', async () => {
    const actionId = await createAction('isolate_device');
    const token = tokenFor(actionId);
    const res = await app.inject({ method: 'POST', url: `/approvals/${token}`, payload: { stepUpPassword: 'definitely-wrong' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('step_up_failed');
  });

  it('T4: a failed step-up leaves the action exactly where it was (proposed, not approved and not reverted from some other state)', async () => {
    const actionId = await createAction('force_password_reset');
    await app.inject({ method: 'POST', url: `/approvals/${tokenFor(actionId)}`, payload: { stepUpPassword: 'wrong' } });

    const { rows } = await asAdmin((c) => c.query('SELECT status FROM actions WHERE id = $1', [actionId]), tenantId);
    expect(rows[0]!.status).toBe('proposed');

    const audit = await asAdmin((c) => c.query(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'step_up_failed' AND subject_id = $2`, [tenantId, actionId]), tenantId);
    expect(audit.rows).toHaveLength(1);
  });

  it('T3: a correct step-up password approves the action and records step-up completion in the audit entry', async () => {
    const actionId = await createAction('disable_user');
    const token = tokenFor(actionId);
    const res = await app.inject({ method: 'POST', url: `/approvals/${token}`, payload: { stepUpPassword: KNOWN_PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, alreadyDecided: false });

    const audit = await asAdmin((c) => c.query(`SELECT payload FROM audit_log WHERE tenant_id = $1 AND action = 'approval_granted' AND subject_id = $2`, [tenantId, actionId]), tenantId);
    expect(audit.rows[0]!.payload).toMatchObject({ step_up_verified: true });

    // P5-05: approval (just asserted above, via the audit entry) is
    // immediately followed by execution in the same request — this
    // fixture's empty `{}` target can never execute for real (see
    // approvals-execution.integration.test.ts), so the final status is
    // 'failed', not 'approved'. 'approved' is a transient intermediate
    // state now, not an end state.
    const { rows } = await asAdmin((c) => c.query('SELECT status FROM actions WHERE id = $1', [actionId]), tenantId);
    expect(rows[0]!.status).toBe('failed');
  });

  it('a non-destructive playbook approves without any step-up password at all, unaffected by this ticket', async () => {
    const actionId = await createAction('block_ip');
    const res = await app.inject({ method: 'POST', url: `/approvals/${tokenFor(actionId)}` });
    expect(res.statusCode).toBe(200);

    const audit = await asAdmin((c) => c.query(`SELECT payload FROM audit_log WHERE tenant_id = $1 AND action = 'approval_granted' AND subject_id = $2`, [tenantId, actionId]), tenantId);
    expect(audit.rows[0]!.payload).toEqual({ case_id: caseId });
  });
});
