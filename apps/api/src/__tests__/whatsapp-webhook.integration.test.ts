/**
 * P5-02 T2/T3/T4 — the webhook's own HTTP surface, against real
 * Postgres. T1 ("delivered against the sandbox with buttons rendered")
 * is not exercised here or anywhere in this repo — see
 * whatsapp-channel.ts's own doc comment for why no real Meta sandbox
 * exists in this environment. Everything downstream of a webhook Meta
 * (or a test standing in for Meta) actually calls IS exercised for
 * real: signature verification, button-to-action resolution, the
 * resulting audit entry, and opt-out recording.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import pg, { type PoolClient } from 'pg';
import { buildApp } from '../app.js';

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel' });
let redis: RedisClientType;
let app: FastifyInstance;
let tenantId: string;
let caseId: string;
let actionId: string;

const APP_SECRET = 'test-whatsapp-app-secret';
const VERIFY_TOKEN = 'test-verify-token';

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

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');
}

function buttonTapPayload(phone: string, payload: string): string {
  return JSON.stringify({
    entry: [{ changes: [{ value: { messages: [{ from: phone, type: 'button', button: { payload, text: 'Approve' } }] } }] }],
  });
}

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();

  app = await buildApp({ pool, redis, cookieSecure: false, whatsappConfig: { verifyToken: VERIFY_TOKEN, appSecret: APP_SECRET } });

  const tenantResult = await asAdmin((c) => c.query<{ id: string }>(`INSERT INTO tenants (name, plan) VALUES ('P5-02 whatsapp webhook probe', 'trial') RETURNING id`));
  tenantId = tenantResult.rows[0]!.id;

  const caseResult = await asAdmin(
    (c) => c.query<{ id: string }>(`INSERT INTO cases (tenant_id, severity, title, window_start) VALUES ($1, 'critical', 'probe case', now()) RETURNING id`, [tenantId]),
    tenantId,
  );
  caseId = caseResult.rows[0]!.id;

  const actionResult = await asAdmin(
    (c) =>
      c.query<{ id: string }>(
        `INSERT INTO actions (tenant_id, case_id, playbook, target, blast_radius) VALUES ($1, $2, 'revoke_sessions', '{}'::jsonb, 'single_user') RETURNING id`,
        [tenantId, caseId],
      ),
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

describe('GET /webhooks/whatsapp (Meta verification handshake)', () => {
  it('echoes the challenge when mode and verify token match', async () => {
    const res = await app.inject({ method: 'GET', url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=echo-me-123` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('echo-me-123');
  });

  it('rejects a wrong verify token', async () => {
    const res = await app.inject({ method: 'GET', url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=echo-me-123' });
    expect(res.statusCode).toBe(403);
  });

  it('does not require a session — a public, unauthenticated path', async () => {
    const res = await app.inject({ method: 'GET', url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=x` });
    expect(res.statusCode).not.toBe(401);
  });
});

describe('POST /webhooks/whatsapp', () => {
  it('T2: rejects a request with an invalid signature', async () => {
    const body = buttonTapPayload('15550000001', `approve:${tenantId}:${actionId}`);
    const res = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }, payload: body });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a request with no signature header at all', async () => {
    const body = buttonTapPayload('15550000001', `approve:${tenantId}:${actionId}`);
    const res = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json' }, payload: body });
    expect(res.statusCode).toBe(401);
  });

  it('T3: a valid "approve" button tap resolves to the right case/action and is audited', async () => {
    const recipient = '15550000002';
    const body = buttonTapPayload(recipient, `approve:${tenantId}:${actionId}`);
    const res = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, payload: body });
    expect(res.statusCode).toBe(200);

    const { rows } = await asAdmin(
      (c) => c.query(`SELECT action, subject_id, payload FROM audit_log WHERE tenant_id = $1 AND action = 'whatsapp_button_tapped' AND subject_id = $2`, [tenantId, actionId]),
      tenantId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ intent: 'approve', case_id: caseId });
  });

  it('a button tap for an action id that does not exist is accepted (200) but not audited', async () => {
    const recipient = '15550000003';
    const fakeActionId = randomUUID();
    const body = buttonTapPayload(recipient, `approve:${tenantId}:${fakeActionId}`);
    const res = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, payload: body });
    expect(res.statusCode).toBe(200);

    const { rows } = await asAdmin(
      (c) => c.query(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND subject_id = $2`, [tenantId, fakeActionId]),
      tenantId,
    );
    expect(rows).toHaveLength(0);
  });

  it('T4: an opt-out button tap stops future delivery and is recorded', async () => {
    const recipient = '15550000004';
    const body = buttonTapPayload(recipient, `optout:${tenantId}`);
    const res = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, payload: body });
    expect(res.statusCode).toBe(200);

    const { rows } = await asAdmin(
      (c) => c.query(`SELECT channel, recipient FROM notification_recipient_optouts WHERE tenant_id = $1 AND recipient = $2`, [tenantId, recipient]),
      tenantId,
    );
    expect(rows).toEqual([{ channel: 'whatsapp', recipient }]);

    const audit = await asAdmin(
      (c) => c.query(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'whatsapp_recipient_opted_out' AND subject_id = $2`, [tenantId, recipient]),
      tenantId,
    );
    expect(audit.rows).toHaveLength(1);
  });
});

describe('when WHATSAPP_VERIFY_TOKEN/WHATSAPP_APP_SECRET are not configured', () => {
  it('returns 503 rather than crashing', async () => {
    const unconfiguredApp = await buildApp({ pool, redis, cookieSecure: false, whatsappConfig: undefined });
    try {
      const res = await unconfiguredApp.inject({ method: 'GET', url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=y' });
      expect(res.statusCode).toBe(503);
    } finally {
      await unconfiguredApp.close();
    }
  });
});
