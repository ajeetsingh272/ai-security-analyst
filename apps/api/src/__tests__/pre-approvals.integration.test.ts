/**
 * P5-06 — the full HTTP round trip for /pre-approvals, against real
 * Postgres and Redis. Mirrors suppressions.integration.test.ts's own
 * admin/read_only fixture pattern.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import pg from 'pg';
import { hashPassword } from '../auth/password.js';
import { buildApp } from '../app.js';

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel' });
let redis: RedisClientType;
let app: FastifyInstance;

const KNOWN_PASSWORD = 'correct horse battery staple';
let tenantId: string;
let adminUserId: string;
let adminEmail: string;
let readOnlyUserId: string;
let readOnlyEmail: string;

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

function cookieFrom(res: { cookies: Array<{ name: string; value: string }> }): string | undefined {
  return res.cookies.find((c) => c.name === 'sentinel_session')?.value;
}

async function signIn(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/sign-in', payload: { email, password: KNOWN_PASSWORD } });
  const cookie = cookieFrom(res);
  if (!cookie) throw new Error(`sign-in failed for ${email}: ${res.statusCode} ${res.body}`);
  return cookie;
}

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();
  await redis.del('ratelimit:signin:ip:127.0.0.1');

  tenantId = randomUUID();
  adminUserId = randomUUID();
  adminEmail = `p5-06-admin-${adminUserId}@example.invalid`;
  readOnlyUserId = randomUUID();
  readOnlyEmail = `p5-06-readonly-${readOnlyUserId}@example.invalid`;

  await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [tenantId, 'P5-06 probe tenant', 'trial']));
  const passwordHash = await hashPassword(KNOWN_PASSWORD);
  await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [adminUserId, adminEmail, passwordHash]));
  await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [readOnlyUserId, readOnlyEmail, passwordHash]));
  await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [tenantId, adminUserId]), tenantId);
  await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'read_only')`, [tenantId, readOnlyUserId]), tenantId);

  app = await buildApp({ pool, redis, cookieSecure: false });
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  await app.close();
  await redis.quit();
  await pool.end();
});

describe('POST/DELETE/GET /pre-approvals/:playbook', () => {
  it('AC1: a playbook is not pre-approved until an admin grants it', async () => {
    const cookie = await signIn(adminEmail);
    const res = await app.inject({ method: 'GET', url: '/pre-approvals/revoke_sessions', cookies: { sentinel_session: cookie } });
    expect(res.json()).toEqual({ playbook: 'revoke_sessions', preApproved: false });
  });

  it('T1: an admin can grant pre-approval', async () => {
    const cookie = await signIn(adminEmail);
    const res = await app.inject({ method: 'POST', url: '/pre-approvals/revoke_sessions', cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, playbook: 'revoke_sessions', preApproved: true });

    const check = await app.inject({ method: 'GET', url: '/pre-approvals/revoke_sessions', cookies: { sentinel_session: cookie } });
    expect(check.json()).toEqual({ playbook: 'revoke_sessions', preApproved: true });
  });

  it('a read_only member cannot grant pre-approval', async () => {
    const cookie = await signIn(readOnlyEmail);
    const res = await app.inject({ method: 'POST', url: '/pre-approvals/block_ip', cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(403);
  });

  it('a read_only member CAN read the current pre-approval status', async () => {
    const cookie = await signIn(readOnlyEmail);
    const res = await app.inject({ method: 'GET', url: '/pre-approvals/revoke_sessions', cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(200);
  });

  it('T2: granting a destructive playbook is refused with 403, not silently ignored', async () => {
    const cookie = await signIn(adminEmail);
    const res = await app.inject({ method: 'POST', url: '/pre-approvals/disable_user', cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('destructive_playbook_cannot_be_pre_approved');

    const check = await app.inject({ method: 'GET', url: '/pre-approvals/disable_user', cookies: { sentinel_session: cookie } });
    expect(check.json()).toEqual({ playbook: 'disable_user', preApproved: false });
  });

  it('T3: an admin can revoke, and it takes effect immediately', async () => {
    const cookie = await signIn(adminEmail);
    await app.inject({ method: 'POST', url: '/pre-approvals/delete_inbox_rule', cookies: { sentinel_session: cookie } });

    const res = await app.inject({ method: 'DELETE', url: '/pre-approvals/delete_inbox_rule', cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, playbook: 'delete_inbox_rule', preApproved: false, wasActive: true });

    const check = await app.inject({ method: 'GET', url: '/pre-approvals/delete_inbox_rule', cookies: { sentinel_session: cookie } });
    expect(check.json()).toEqual({ playbook: 'delete_inbox_rule', preApproved: false });
  });
});
