/**
 * P5-05 — playbook execution, wired into the same /approvals/:token
 * POST that P5-03/04 already built, against real Postgres and Redis.
 *
 * No real M365 OAuth credentials or test tenant exist in this
 * environment (see graph-access.ts's own doc comment) — every
 * playbook here runs against `unavailableGraphClient` (no M365
 * connector configured for this test's tenant at all), which is itself
 * a genuine, honestly-reached failure path: T1 ("executes correctly
 * against a Microsoft test tenant") is NOT exercised by this file, but
 * everything downstream of "Graph said no" — marking the action
 * failed, recording manual steps, returning the case to
 * awaiting_approval — is exercised for real. block_ip/isolate_device
 * never touch Graph at all, so THEIR tests prove the honest
 * "no backend yet" path independent of any M365 connection state.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import pg, { type PoolClient } from 'pg';
import { signApprovalToken, type ApprovalTokenPayload } from '@sentinel/approval-tokens';
import { ActionsRepository, withTenantContext } from '@sentinel/db';
import { buildApp } from '../app.js';

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel' });
let redis: RedisClientType;
let app: FastifyInstance;
let tenantId: string;
let caseId: string;
let approverId: string;

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

async function createAction(playbook: string, target: Record<string, unknown>): Promise<string> {
  const result = await asAdmin(
    (c) => c.query<{ id: string }>(`INSERT INTO actions (tenant_id, case_id, playbook, target, blast_radius) VALUES ($1, $2, $3, $4, 'single_user') RETURNING id`, [
      tenantId,
      caseId,
      playbook,
      JSON.stringify(target),
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

  const tenantResult = await asAdmin((c) => c.query<{ id: string }>(`INSERT INTO tenants (name, plan) VALUES ('P5-05 execution probe', 'trial') RETURNING id`));
  tenantId = tenantResult.rows[0]!.id;
  const caseResult = await asAdmin(
    (c) => c.query<{ id: string }>(`INSERT INTO cases (tenant_id, severity, title, window_start) VALUES ($1, 'critical', 'probe case', now()) RETURNING id`, [tenantId]),
    tenantId,
  );
  caseId = caseResult.rows[0]!.id;
  const userResult = await asAdmin((c) => c.query<{ id: string }>(`INSERT INTO users (email) VALUES ($1) RETURNING id`, [`exec-probe-${randomUUID()}@example.com`]));
  approverId = userResult.rows[0]!.id;
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [approverId]));
  await app.close();
  await redis.quit();
  await pool.end();
});

describe('playbook execution after approval', () => {
  it('a Graph-calling playbook with no M365 connection fails execution, records manual steps, and returns the case to awaiting_approval', async () => {
    const actionId = await createAction('revoke_sessions', { userId: 'u1', expectedUpn: 'priya@example.com' });
    const res = await app.inject({ method: 'POST', url: `/approvals/${tokenFor(actionId)}` });
    expect(res.statusCode).toBe(200);

    const { rows } = await asAdmin((c) => c.query('SELECT status, error FROM actions WHERE id = $1', [actionId]), tenantId);
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.error).toContain('unexpected Graph response 503');

    const audit = await asAdmin(
      (c) => c.query(`SELECT action, payload FROM audit_log WHERE tenant_id = $1 AND subject_id = $2 ORDER BY id ASC`, [tenantId, actionId]),
      tenantId,
    );
    const actions = audit.rows.map((r) => r.action);
    expect(actions).toEqual(['approval_granted', 'action_failed']);
    expect(audit.rows[1]!.payload).toMatchObject({ manual_steps: expect.any(String) });

    const transition = await asAdmin(
      (c) => c.query(`SELECT to_state, reason FROM case_transitions WHERE case_id = $1 ORDER BY id DESC LIMIT 1`, [caseId]),
      tenantId,
    );
    expect(transition.rows[0]!.to_state).toBe('awaiting_approval');
    expect(transition.rows[0]!.reason).toContain(actionId);
  });

  it('T4: block_ip (no automated backend) always fails honestly with manual steps, independent of any M365 connection', async () => {
    const actionId = await createAction('block_ip', { ipAddress: '203.0.113.9' });
    const res = await app.inject({ method: 'POST', url: `/approvals/${tokenFor(actionId)}` });
    expect(res.statusCode).toBe(200);

    const { rows } = await asAdmin((c) => c.query('SELECT status, error FROM actions WHERE id = $1', [actionId]), tenantId);
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.error).toBe('block_ip has no automated backend yet');
  });

  // T3 ("a playbook whose target no longer matches the premise
  // refuses to execute") needs a Graph client that can distinguish
  // "premise genuinely doesn't match" from "Graph unreachable" —
  // proven for real in @sentinel/playbooks' own unit tests
  // (FakeGraphClient has controllable user/rule state), which this
  // file's always-503 unavailableGraphClient cannot express. This file
  // proves the WIRING around execution instead: that a destructive
  // playbook still goes through P5-04's own step-up gate before
  // execution is even attempted, unaffected by P5-05 landing behind it.
  it("P5-04's step-up gate still runs before execution is attempted — a wrong step-up password never reaches markExecuting at all", async () => {
    const actionId = await createAction('disable_user', { userId: 'u1', expectedUpn: 'priya@example.com' });
    await app.inject({ method: 'POST', url: `/approvals/${tokenFor(actionId)}`, payload: { stepUpPassword: 'wrong-password' } });

    const { rows } = await asAdmin((c) => c.query('SELECT status FROM actions WHERE id = $1', [actionId]), tenantId);
    expect(rows[0]!.status).toBe('proposed'); // never even reached 'approved', let alone 'executing'
  });

  it('markExecuting is idempotent-guarded: an action not in "approved" is never (re-)executed', async () => {
    const actionId = await createAction('block_ip', { ipAddress: '203.0.113.9' });
    await asAdmin((c) => c.query(`UPDATE actions SET status = 'succeeded' WHERE id = $1`, [actionId]), tenantId);

    // Re-POSTing the SAME token is impossible (the nonce can only ever
    // burn once) — this directly exercises ActionsRepository.markExecuting
    // itself, the guard this whole file's other tests rely on implicitly.
    const executed = await withTenantContext(tenantId, () => new ActionsRepository(pool).markExecuting(actionId));
    expect(executed).toBe(false);

    const { rows } = await asAdmin((c) => c.query('SELECT status FROM actions WHERE id = $1', [actionId]), tenantId);
    expect(rows[0]!.status).toBe('succeeded'); // untouched
  });
});
