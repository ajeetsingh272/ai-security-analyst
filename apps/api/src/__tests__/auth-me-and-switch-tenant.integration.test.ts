/**
 * P6-01: `GET /auth/me` (the dashboard shell's one source of truth for who
 * is signed in, as which tenant, with which role) and `POST
 * /auth/switch-tenant` (the real cross-tenant switch behind the shell's
 * tenant switcher, built on P0-09's already-existing but previously unused
 * `canActAsTenant`).
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import pg from 'pg';
import { hashPassword } from '../auth/password.js';
import { authPlugin } from '../auth/auth-plugin.js';
import { tenantContextPlugin } from '../plugins/tenant-context.js';

const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel',
});
let redis: RedisClientType;
let app: FastifyInstance;

const KNOWN_PASSWORD = 'correct horse battery staple';

async function asAdmin<T>(fn: (client: pg.PoolClient) => Promise<T>, tenantId?: string): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE sentinel_app');
    if (tenantId) await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
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

function cookieFrom(res: { cookies: Array<{ name: string; value: string }> }): string {
  const value = res.cookies.find((c) => c.name === 'sentinel_session')?.value;
  if (!value) throw new Error('no session cookie in response');
  return value;
}

const tenantIds: string[] = [];
const userIds: string[] = [];

async function makeTenant(name: string, plan: string): Promise<string> {
  const id = randomUUID();
  await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [id, name, plan]));
  tenantIds.push(id);
  return id;
}

async function makeUser(email: string): Promise<{ id: string; password: string }> {
  const id = randomUUID();
  const passwordHash = await hashPassword(KNOWN_PASSWORD);
  await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [id, email, passwordHash]));
  userIds.push(id);
  return { id, password: KNOWN_PASSWORD };
}

async function addMembership(tenantId: string, userId: string, role: string): Promise<void> {
  await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)`, [tenantId, userId, role]), tenantId);
}

async function signIn(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/sign-in', payload: { email, password: KNOWN_PASSWORD } });
  expect(res.statusCode).toBe(200);
  return cookieFrom(res);
}

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();
  await redis.del('ratelimit:signin:ip:127.0.0.1');

  app = Fastify();
  await app.register(authPlugin, { pool, redis, cookieSecure: false });
  await app.register(tenantContextPlugin, { publicPaths: ['/auth/sign-in', '/auth/sign-out'] });
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = ANY($1)', [tenantIds]));
  await asAdmin((c) => c.query('DELETE FROM users WHERE id = ANY($1)', [userIds]));
  await redis.del('ratelimit:signin:ip:127.0.0.1');
  await redis.quit();
  await pool.end();
  await app.close();
});

describe('GET /auth/me', () => {
  it('reports the signed-in user, tenant and role', async () => {
    const tenantId = await makeTenant('P6-01 /auth/me probe', 'trial');
    const email = `p6-01-me-${randomUUID()}@example.invalid`;
    const user = await makeUser(email);
    await addMembership(tenantId, user.id, 'owner');

    const cookie = await signIn(email);
    const res = await app.inject({ method: 'GET', url: '/auth/me', cookies: { sentinel_session: cookie } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      userId: user.id,
      email,
      tenantId,
      tenantName: 'P6-01 /auth/me probe',
      role: 'owner',
      actingViaMspTenantId: null,
      isActingAsClient: false,
    });
  });

  it('returns 401 with no session', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /auth/switch-tenant', () => {
  it('T2 (rescoped): an MSP user can switch into a linked client, and back', async () => {
    const mspTenant = await makeTenant('P6-01 MSP probe', 'msp');
    const clientTenant = await makeTenant('P6-01 linked client probe', 'trial');
    const email = `p6-01-switch-${randomUUID()}@example.invalid`;
    const user = await makeUser(email);
    await addMembership(mspTenant, user.id, 'owner');
    await asAdmin((c) => c.query('INSERT INTO msp_links (msp_tenant_id, client_tenant_id) VALUES ($1, $2)', [mspTenant, clientTenant]), mspTenant);

    const cookie = await signIn(email);

    const before = await app.inject({ method: 'GET', url: '/auth/me', cookies: { sentinel_session: cookie } });
    expect(before.json()).toMatchObject({ tenantId: mspTenant, role: 'owner', isActingAsClient: false });

    const switched = await app.inject({
      method: 'POST',
      url: '/auth/switch-tenant',
      cookies: { sentinel_session: cookie },
      payload: { targetTenantId: clientTenant },
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toMatchObject({ ok: true, tenantId: clientTenant, role: 'read_only' });

    const during = await app.inject({ method: 'GET', url: '/auth/me', cookies: { sentinel_session: cookie } });
    expect(during.json()).toMatchObject({
      tenantId: clientTenant,
      role: 'read_only',
      actingViaMspTenantId: clientTenant,
      isActingAsClient: true,
      homeTenantId: mspTenant,
      homeTenantName: 'P6-01 MSP probe',
    });

    const back = await app.inject({
      method: 'POST',
      url: '/auth/switch-tenant',
      cookies: { sentinel_session: cookie },
      payload: { targetTenantId: null },
    });
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ ok: true, tenantId: mspTenant });

    const after = await app.inject({ method: 'GET', url: '/auth/me', cookies: { sentinel_session: cookie } });
    expect(after.json()).toMatchObject({ tenantId: mspTenant, role: 'owner', isActingAsClient: false });
  });

  it('refuses to switch into a tenant with no active link', async () => {
    const mspTenant = await makeTenant('P6-01 MSP probe (unlinked)', 'msp');
    const unrelatedTenant = await makeTenant('P6-01 unrelated tenant probe', 'trial');
    const email = `p6-01-unlinked-${randomUUID()}@example.invalid`;
    const user = await makeUser(email);
    await addMembership(mspTenant, user.id, 'owner');

    const cookie = await signIn(email);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/switch-tenant',
      cookies: { sentinel_session: cookie },
      payload: { targetTenantId: unrelatedTenant },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('not_linked');

    const me = await app.inject({ method: 'GET', url: '/auth/me', cookies: { sentinel_session: cookie } });
    expect(me.json()).toMatchObject({ tenantId: mspTenant, isActingAsClient: false });
  });
});
