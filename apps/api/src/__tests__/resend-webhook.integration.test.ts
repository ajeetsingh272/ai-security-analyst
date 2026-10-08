/**
 * P5-08 T3 — a bounce/complaint event is processed and surfaced on
 * the tenant's channel health, against real Postgres and Redis.
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

const SIGNING_SECRET = 'whsec_dGVzdC1zaWduaW5nLXNlY3JldC1rZXk='; // base64("test-signing-secret-key")

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

function svixHeaders(id: string, timestamp: number, body: string): Record<string, string> {
  const secretBytes = Buffer.from(SIGNING_SECRET.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${id}.${timestamp}.${body}`;
  const signature = createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  return { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': `v1,${signature}` };
}

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();
  app = await buildApp({ pool, redis, cookieSecure: false, resendWebhookConfig: { signingSecret: SIGNING_SECRET } });

  const tenantResult = await asAdmin((c) => c.query<{ id: string }>(`INSERT INTO tenants (name, plan) VALUES ('P5-08 resend webhook probe', 'trial') RETURNING id`));
  tenantId = tenantResult.rows[0]!.id;
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  await app.close();
  await redis.quit();
  await pool.end();
});

describe('POST /webhooks/resend', () => {
  it('rejects an invalid signature', async () => {
    const body = JSON.stringify({ type: 'email.bounced', data: { to: ['owner@example.com'], tenant_id: tenantId } });
    const id = `msg_${randomUUID()}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const res = await app.inject({ method: 'POST', url: '/webhooks/resend', headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }, payload: body });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a stale timestamp even with an otherwise-valid signature', async () => {
    const body = JSON.stringify({ type: 'email.bounced', data: { to: ['owner@example.com'], tenant_id: tenantId } });
    const staleTimestamp = Math.floor(Date.now() / 1000) - 10 * 60;
    const id = `msg_${randomUUID()}`;
    const headers = svixHeaders(id, staleTimestamp, body);
    const res = await app.inject({ method: 'POST', url: '/webhooks/resend', headers, payload: body });
    expect(res.statusCode).toBe(401);
  });

  it('T3: a bounce event records the recipient as opted out and is audited', async () => {
    const recipient = `bounced-${randomUUID()}@example.com`;
    const body = JSON.stringify({ type: 'email.bounced', data: { to: [recipient], tenant_id: tenantId } });
    const id = `msg_${randomUUID()}`;
    const headers = svixHeaders(id, Math.floor(Date.now() / 1000), body);

    const res = await app.inject({ method: 'POST', url: '/webhooks/resend', headers, payload: body });
    expect(res.statusCode).toBe(200);

    const { rows } = await asAdmin((c) => c.query('SELECT channel, recipient FROM notification_recipient_optouts WHERE tenant_id = $1 AND recipient = $2', [tenantId, recipient]), tenantId);
    expect(rows).toEqual([{ channel: 'email', recipient }]);

    const audit = await asAdmin((c) => c.query(`SELECT action FROM audit_log WHERE tenant_id = $1 AND subject_id = $2`, [tenantId, recipient]), tenantId);
    expect(audit.rows).toEqual([{ action: 'email_bounced' }]);
  });

  it('a complaint event ALSO records the recipient as opted out', async () => {
    const recipient = `complained-${randomUUID()}@example.com`;
    const body = JSON.stringify({ type: 'email.complained', data: { to: [recipient], tenant_id: tenantId } });
    const id = `msg_${randomUUID()}`;
    const headers = svixHeaders(id, Math.floor(Date.now() / 1000), body);

    await app.inject({ method: 'POST', url: '/webhooks/resend', headers, payload: body });

    const { rows } = await asAdmin((c) => c.query('SELECT 1 FROM notification_recipient_optouts WHERE tenant_id = $1 AND channel = $2 AND recipient = $3', [tenantId, 'email', recipient]), tenantId);
    expect(rows).toHaveLength(1);
  });

  it('an unrelated event type (e.g. email.delivered) is accepted but changes nothing', async () => {
    const recipient = `delivered-${randomUUID()}@example.com`;
    const body = JSON.stringify({ type: 'email.delivered', data: { to: [recipient], tenant_id: tenantId } });
    const id = `msg_${randomUUID()}`;
    const headers = svixHeaders(id, Math.floor(Date.now() / 1000), body);

    const res = await app.inject({ method: 'POST', url: '/webhooks/resend', headers, payload: body });
    expect(res.statusCode).toBe(200);

    const { rows } = await asAdmin((c) => c.query('SELECT 1 FROM notification_recipient_optouts WHERE tenant_id = $1 AND recipient = $2', [tenantId, recipient]), tenantId);
    expect(rows).toHaveLength(0);
  });

  it('returns 503 rather than crashing when RESEND_WEBHOOK_SECRET is not configured', async () => {
    const unconfiguredApp = await buildApp({ pool, redis, cookieSecure: false, resendWebhookConfig: undefined });
    try {
      const res = await unconfiguredApp.inject({ method: 'POST', url: '/webhooks/resend', headers: { 'content-type': 'application/json' }, payload: '{}' });
      expect(res.statusCode).toBe(503);
    } finally {
      await unconfiguredApp.close();
    }
  });
});
