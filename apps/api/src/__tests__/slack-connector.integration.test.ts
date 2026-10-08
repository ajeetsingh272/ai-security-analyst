/**
 * P5-07 T1/T4 — the install -> callback -> revoke flow against real
 * Postgres and Redis, and a LOCAL MOCK of Slack's own API (see
 * mock-slack-server.ts's own doc comment for exactly what gap that
 * is — the closest honest substitute without a real Slack app).
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import pg from 'pg';
import { hashPassword } from '../auth/password.js';
import { buildApp } from '../app.js';
import { startMockSlackServer, type MockSlackServer } from './mock-slack-server.js';

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel' });
let redis: RedisClientType;
let app: FastifyInstance;
let mock: MockSlackServer;
const kmsMasterKey = randomBytes(32).toString('base64');

const KNOWN_PASSWORD = 'correct horse battery staple';
let tenantId: string;
let userId: string;
let userEmail: string;

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

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();
  await redis.del('ratelimit:signin:ip:127.0.0.1');
  process.env['KMS_LOCAL_MASTER_KEY'] = kmsMasterKey;

  tenantId = randomUUID();
  userId = randomUUID();
  userEmail = `p5-07-${userId}@example.invalid`;
  await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [tenantId, 'P5-07 slack probe', 'trial']));
  const passwordHash = await hashPassword(KNOWN_PASSWORD);
  await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [userId, userEmail, passwordHash]));
  await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [tenantId, userId]), tenantId);
});

beforeEach(async () => {
  mock = await startMockSlackServer();
  app = await buildApp({
    pool,
    redis,
    cookieSecure: false,
    slackOAuthConfig: { clientId: 'test-client-id', clientSecret: 'test-client-secret', redirectUri: 'http://localhost/callback', baseUrl: mock.baseUrl },
  });
});

afterEach(async () => {
  await app.close();
  await mock.close();
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  await redis.quit();
  await pool.end();
});

async function signIn(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/sign-in', payload: { email: userEmail, password: KNOWN_PASSWORD } });
  const cookie = cookieFrom(res);
  if (!cookie) throw new Error(`sign-in failed: ${res.statusCode} ${res.body}`);
  return cookie;
}

describe('GET /connectors/slack/connect', () => {
  it('returns 503 when no Slack app is registered', async () => {
    const unconfiguredApp = await buildApp({ pool, redis, cookieSecure: false, slackOAuthConfig: undefined });
    try {
      const cookie = await signIn();
      const res = await unconfiguredApp.inject({ method: 'GET', url: '/connectors/slack/connect', cookies: { sentinel_session: cookie } });
      expect(res.statusCode).toBe(503);
    } finally {
      await unconfiguredApp.close();
    }
  });

  it('redirects to the real documented Slack authorize URL shape', async () => {
    const cookie = await signIn();
    const res = await app.inject({ method: 'GET', url: '/connectors/slack/connect?testChannelId=C-TEST', cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.pathname).toBe('/oauth/v2/authorize');
    expect(location.searchParams.get('client_id')).toBe('test-client-id');
    expect(location.searchParams.get('scope')).toBe('chat:write,channels:read');
    expect(location.searchParams.get('state')).toBeTruthy();
  });
});

describe('GET /connectors/slack/callback', () => {
  it('T1: completes installation, stores credentials, and posts a real test alert', async () => {
    const cookie = await signIn();
    const connectRes = await app.inject({ method: 'GET', url: '/connectors/slack/connect?testChannelId=C-TEST', cookies: { sentinel_session: cookie } });
    const state = new URL(connectRes.headers.location as string).searchParams.get('state')!;

    const callbackRes = await app.inject({ method: 'GET', url: `/connectors/slack/callback?code=real-looking-code&state=${state}`, cookies: { sentinel_session: cookie } });
    expect(callbackRes.statusCode).toBe(200);
    expect(callbackRes.json()).toMatchObject({ ok: true, connector: 'slack', status: 'healthy', teamName: 'Mock Workspace', testAlertPosted: true });

    expect(mock.exchangedCodes).toContain('real-looking-code');
    expect(mock.postedMessages).toHaveLength(1);
    expect(mock.postedMessages[0]!.channel).toBe('C-TEST');

    const { rows } = await asAdmin((c) => c.query(`SELECT status FROM connectors WHERE tenant_id = $1 AND kind = 'slack'`, [tenantId]), tenantId);
    expect(rows[0]!.status).toBe('healthy');
  });

  it('rejects an invalid or expired state rather than trusting the callback anyway', async () => {
    const cookie = await signIn();
    const res = await app.inject({ method: 'GET', url: '/connectors/slack/callback?code=whatever&state=not-a-real-state', cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_or_expired_state');
  });
});

describe('POST /connectors/slack/revoke', () => {
  it('T4: cleanly disables the connector', async () => {
    const cookie = await signIn();
    const connectRes = await app.inject({ method: 'GET', url: '/connectors/slack/connect', cookies: { sentinel_session: cookie } });
    const state = new URL(connectRes.headers.location as string).searchParams.get('state')!;
    await app.inject({ method: 'GET', url: `/connectors/slack/callback?code=to-be-revoked&state=${state}`, cookies: { sentinel_session: cookie } });

    const revokeRes = await app.inject({ method: 'POST', url: '/connectors/slack/revoke', cookies: { sentinel_session: cookie } });
    expect(revokeRes.statusCode).toBe(200);

    const { rows } = await asAdmin((c) => c.query(`SELECT status, credentials FROM connectors WHERE tenant_id = $1 AND kind = 'slack'`, [tenantId]), tenantId);
    expect(rows[0]!.status).toBe('revoked');
    expect(rows[0]!.credentials).toBeNull();
  });

  it('returns 404 for a tenant that never connected Slack at all', async () => {
    const neverConnectedTenantId = randomUUID();
    const neverConnectedUserId = randomUUID();
    const neverConnectedEmail = `p5-07-never-${neverConnectedUserId}@example.invalid`;
    await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [neverConnectedTenantId, 'never connected', 'trial']));
    const passwordHash = await hashPassword(KNOWN_PASSWORD);
    await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [neverConnectedUserId, neverConnectedEmail, passwordHash]));
    await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [neverConnectedTenantId, neverConnectedUserId]), neverConnectedTenantId);

    try {
      const signInRes = await app.inject({ method: 'POST', url: '/auth/sign-in', payload: { email: neverConnectedEmail, password: KNOWN_PASSWORD } });
      const cookie = cookieFrom(signInRes)!;
      const res = await app.inject({ method: 'POST', url: '/connectors/slack/revoke', cookies: { sentinel_session: cookie } });
      expect(res.statusCode).toBe(404);
    } finally {
      await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [neverConnectedTenantId]));
      await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [neverConnectedUserId]));
    }
  });
});

describe('GET/PUT /connectors/slack/channel-routing', () => {
  it('AC4: per-severity channel routing is configurable after install', async () => {
    const cookie = await signIn();
    const connectRes = await app.inject({ method: 'GET', url: '/connectors/slack/connect', cookies: { sentinel_session: cookie } });
    const state = new URL(connectRes.headers.location as string).searchParams.get('state')!;
    await app.inject({ method: 'GET', url: `/connectors/slack/callback?code=routing-test&state=${state}`, cookies: { sentinel_session: cookie } });

    const putRes = await app.inject({ method: 'PUT', url: '/connectors/slack/channel-routing', cookies: { sentinel_session: cookie }, payload: { severity: 'critical', channelId: 'C-CRITICAL' } });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json().channelRouting.critical).toBe('C-CRITICAL');

    const getRes = await app.inject({ method: 'GET', url: '/connectors/slack/channel-routing', cookies: { sentinel_session: cookie } });
    expect(getRes.json().channelRouting.critical).toBe('C-CRITICAL');
  });

  it('rejects an invalid severity', async () => {
    const cookie = await signIn();
    const connectRes = await app.inject({ method: 'GET', url: '/connectors/slack/connect', cookies: { sentinel_session: cookie } });
    const state = new URL(connectRes.headers.location as string).searchParams.get('state')!;
    await app.inject({ method: 'GET', url: `/connectors/slack/callback?code=invalid-severity-test&state=${state}`, cookies: { sentinel_session: cookie } });

    const res = await app.inject({ method: 'PUT', url: '/connectors/slack/channel-routing', cookies: { sentinel_session: cookie }, payload: { severity: 'apocalyptic', channelId: 'C-X' } });
    expect(res.statusCode).toBe(400);
  });
});
