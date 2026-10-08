/**
 * P5-07 T2/T3 — the interactivity webhook's own signature/replay
 * verification, and that a verified "approve" button tap reaches the
 * EXACT same decideApproval() a WhatsApp or dashboard click does
 * (proving "the same approval semantics as WhatsApp" is literally
 * true, not just intended), against real Postgres and Redis.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { createHmac, randomUUID } from 'node:crypto';
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

const SECRET = 'test-approval-token-secret';
const SIGNING_SECRET = 'test-slack-signing-secret';

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
  return signApprovalToken({ caseId, actionId, tenantId, approverId: 'approver-1', nonce: randomUUID(), exp: Math.floor(Date.now() / 1000) + 900, ...overrides }, SECRET);
}

function signedRequest(body: string, timestamp = Math.floor(Date.now() / 1000)): { body: string; headers: Record<string, string> } {
  const basestring = `v0:${timestamp}:${body}`;
  const signature = `v0=${createHmac('sha256', SIGNING_SECRET).update(basestring).digest('hex')}`;
  return { body, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': String(timestamp), 'x-slack-signature': signature } };
}

function interactionBody(actionId: string, caseActionId: 'approve' | 'call_me_first'): string {
  return interactionBodyForToken(tokenFor(actionId), caseActionId);
}

function interactionBodyForToken(token: string, caseActionId: 'approve' | 'call_me_first'): string {
  const payload = JSON.stringify({ type: 'block_actions', actions: [{ action_id: caseActionId, value: token }] });
  return new URLSearchParams({ payload }).toString();
}

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();
  app = await buildApp({ pool, redis, cookieSecure: false, approvalsConfig: { tokenSecret: SECRET }, slackWebhookConfig: { signingSecret: SIGNING_SECRET } });

  const tenantResult = await asAdmin((c) => c.query<{ id: string }>(`INSERT INTO tenants (name, plan) VALUES ('P5-07 slack webhook probe', 'trial') RETURNING id`));
  tenantId = tenantResult.rows[0]!.id;
  const caseResult = await asAdmin(
    (c) => c.query<{ id: string }>(`INSERT INTO cases (tenant_id, severity, title, window_start) VALUES ($1, 'critical', 'probe case', now()) RETURNING id`, [tenantId]),
    tenantId,
  );
  caseId = caseResult.rows[0]!.id;
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  await app.close();
  await redis.quit();
  await pool.end();
});

describe('POST /webhooks/slack/interactions', () => {
  it('T2: rejects a request with an invalid signature', async () => {
    const actionId = await createAction('revoke_sessions', { userId: 'u1', expectedUpn: 'x@example.com' });
    const body = interactionBody(actionId, 'approve');
    const res = await app.inject({ method: 'POST', url: '/webhooks/slack/interactions', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)), 'x-slack-signature': 'v0=' + '0'.repeat(64) }, payload: body });
    expect(res.statusCode).toBe(401);

    const { rows } = await asAdmin((c) => c.query('SELECT status FROM actions WHERE id = $1', [actionId]), tenantId);
    expect(rows[0]!.status).toBe('proposed'); // never reached decideApproval at all
  });

  it('rejects a request with no signature header at all', async () => {
    const actionId = await createAction('revoke_sessions', { userId: 'u1', expectedUpn: 'x@example.com' });
    const body = interactionBody(actionId, 'approve');
    const res = await app.inject({ method: 'POST', url: '/webhooks/slack/interactions', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: body });
    expect(res.statusCode).toBe(401);
  });

  it('T3: rejects a request whose timestamp is outside the replay window, even with an otherwise-valid signature', async () => {
    const actionId = await createAction('revoke_sessions', { userId: 'u1', expectedUpn: 'x@example.com' });
    const body = interactionBody(actionId, 'approve');
    const staleTimestamp = Math.floor(Date.now() / 1000) - 10 * 60; // 10 minutes old
    const { headers } = signedRequest(body, staleTimestamp);

    const res = await app.inject({ method: 'POST', url: '/webhooks/slack/interactions', headers, payload: body });
    expect(res.statusCode).toBe(401);

    const { rows } = await asAdmin((c) => c.query('SELECT status FROM actions WHERE id = $1', [actionId]), tenantId);
    expect(rows[0]!.status).toBe('proposed');
  });

  it('a valid, fresh "approve" interaction reaches the exact same decideApproval path a WhatsApp/dashboard click does', async () => {
    const actionId = await createAction('revoke_sessions', { userId: 'u1', expectedUpn: 'x@example.com' });
    const body = interactionBody(actionId, 'approve');
    const { headers } = signedRequest(body);

    const res = await app.inject({ method: 'POST', url: '/webhooks/slack/interactions', headers, payload: body });
    expect(res.statusCode).toBe(200);

    const audit = await asAdmin((c) => c.query(`SELECT action FROM audit_log WHERE tenant_id = $1 AND subject_id = $2 ORDER BY id ASC`, [tenantId, actionId]), tenantId);
    // approval_granted (decideApproval's own approve step), then
    // action_failed (execute-action.ts's honest "no M365 connection"
    // path) — the SAME two-step sequence approvals.integration.test.ts
    // already proves for a plain HTTP POST to /approvals/:token.
    expect(audit.rows.map((r) => r.action)).toEqual(['approval_granted', 'action_failed']);
  });

  it('a "call_me_first" interaction is audited without burning the token — a later real approve on the SAME token still succeeds', async () => {
    const actionId = await createAction('revoke_sessions', { userId: 'u1', expectedUpn: 'x@example.com' });
    const token = tokenFor(actionId);

    const callMeFirstBody = interactionBodyForToken(token, 'call_me_first');
    const { headers: callMeFirstHeaders } = signedRequest(callMeFirstBody);
    const callMeFirstRes = await app.inject({ method: 'POST', url: '/webhooks/slack/interactions', headers: callMeFirstHeaders, payload: callMeFirstBody });
    expect(callMeFirstRes.statusCode).toBe(200);

    const { rows: afterCallMeFirst } = await asAdmin((c) => c.query('SELECT status FROM actions WHERE id = $1', [actionId]), tenantId);
    expect(afterCallMeFirst[0]!.status).toBe('proposed'); // nothing decided yet

    const approveBody = interactionBodyForToken(token, 'approve');
    const { headers: approveHeaders } = signedRequest(approveBody);
    const approveRes = await app.inject({ method: 'POST', url: '/webhooks/slack/interactions', headers: approveHeaders, payload: approveBody });
    expect(approveRes.statusCode).toBe(200);

    const audit = await asAdmin((c) => c.query(`SELECT action FROM audit_log WHERE tenant_id = $1 AND subject_id = $2 ORDER BY id ASC`, [tenantId, actionId]), tenantId);
    expect(audit.rows.map((r) => r.action)).toEqual(['call_me_first_requested', 'approval_granted', 'action_failed']);
  });

  it('returns 503 rather than crashing when SLACK_SIGNING_SECRET is not configured', async () => {
    const unconfiguredApp = await buildApp({ pool, redis, cookieSecure: false, slackWebhookConfig: undefined });
    try {
      const res = await unconfiguredApp.inject({ method: 'POST', url: '/webhooks/slack/interactions', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'payload=%7B%7D' });
      expect(res.statusCode).toBe(503);
    } finally {
      await unconfiguredApp.close();
    }
  });
});
