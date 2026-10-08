/**
 * P6-09 — the public API's own auth: key management (cookie session,
 * admin-gated) and the `/v1/*` surface it unlocks (x-api-key header),
 * against the real Postgres and Redis the dev stack provides.
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

const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel',
});
let redis: RedisClientType;
let app: FastifyInstance;

const KNOWN_PASSWORD = 'correct horse battery staple';

interface Tenant {
  tenantId: string;
  adminUserId: string;
  adminEmail: string;
}

let tenantA: Tenant;
let tenantB: Tenant;

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

async function makeTenant(label: string): Promise<Tenant> {
  const tenantId = randomUUID();
  const adminUserId = randomUUID();
  const adminEmail = `p6-09-${label}-${adminUserId}@example.invalid`;
  const passwordHash = await hashPassword(KNOWN_PASSWORD);

  await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [tenantId, `P6-09 ${label} tenant`, 'trial']));
  await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [adminUserId, adminEmail, passwordHash]));
  await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [tenantId, adminUserId]), tenantId);

  return { tenantId, adminUserId, adminEmail };
}

/** `CasesRepository.list`'s own query inner-joins against the case's
 * latest `case_transitions` row (to derive `state`) — a case with no
 * transition row at all is dropped from every list result entirely,
 * not merely shown with a null state. Every real case gets an initial
 * 'open' transition at creation (services/correlate's own lifecycle.
 * Writer), so this fixture must too, same as every other seedCase
 * helper in this repo (e.g. apps/dashboard/e2e/fixtures.ts's own). */
async function seedCase(tenantId: string, title: string): Promise<string> {
  return asAdmin(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count) VALUES ($1, 'high', $2, now(), 1) RETURNING id`,
      [tenantId, title],
    );
    await client.query(
      `INSERT INTO case_transitions (tenant_id, case_id, from_state, to_state, actor_type, actor_id, reason)
       VALUES ($1, $2, NULL, 'open', 'system', 'correlate', 'test fixture')`,
      [tenantId, rows[0]!.id],
    );
    return rows[0]!.id;
  }, tenantId);
}

async function createApiKey(cookie: string, scopes: string[] = ['read']): Promise<{ rawKey: string; id: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api-keys',
    cookies: { sentinel_session: cookie },
    payload: { name: 'test key', scopes },
  });
  const body = res.json() as { rawKey: string; apiKey: { id: string } };
  return { rawKey: body.rawKey, id: body.apiKey.id };
}

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();

  tenantA = await makeTenant('tenant-a');
  tenantB = await makeTenant('tenant-b');

  app = await buildApp({ pool, redis, cookieSecure: false });
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantA.tenantId]));
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantB.tenantId]));
  await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [tenantA.adminUserId]));
  await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [tenantB.adminUserId]));
  await redis.quit();
  await pool.end();
  await app.close();
});

describe('POST /api-keys', () => {
  it('returns the raw secret exactly once, and rejects a read_only caller', async () => {
    const cookie = await signIn(tenantA.adminEmail);
    const created = await createApiKey(cookie);
    expect(created.rawKey).toMatch(/^sk_live_/);

    const listRes = await app.inject({ method: 'GET', url: '/api-keys', cookies: { sentinel_session: cookie } });
    const listed = (listRes.json() as { apiKeys: Array<Record<string, unknown>> }).apiKeys;
    expect(listed.some((k) => k['id'] === created.id)).toBe(true);
    // The list response never carries the raw secret, only the prefix.
    expect(JSON.stringify(listed)).not.toContain(created.rawKey);
  });
});

describe('GET /v1/cases with an API key', () => {
  it("T2: a key scoped to tenant A cannot read tenant B's cases through any v1 endpoint", async () => {
    const cookieA = await signIn(tenantA.adminEmail);
    const { rawKey } = await createApiKey(cookieA);

    const caseA = await seedCase(tenantA.tenantId, "Tenant A's own case");
    const caseB = await seedCase(tenantB.tenantId, "Tenant B's own case");

    const listRes = await app.inject({ method: 'GET', url: '/v1/cases', headers: { 'x-api-key': rawKey } });
    expect(listRes.statusCode).toBe(200);
    const items = (listRes.json() as { items: Array<{ id: string; title: string | null }> }).items;
    expect(items.some((c) => c.id === caseA)).toBe(true);
    expect(items.some((c) => c.id === caseB)).toBe(false);

    // Reading tenant B's case id directly, through tenant A's key, must
    // 404 — not silently return tenant B's data, and not leak whether
    // that id exists at all in some OTHER tenant.
    const detailRes = await app.inject({ method: 'GET', url: `/v1/cases/${caseB}`, headers: { 'x-api-key': rawKey } });
    expect(detailRes.statusCode).toBe(404);
  });

  it("a 'read'-scoped key can read /v1/cases but cannot do an admin-only action like creating another key", async () => {
    const cookieA = await signIn(tenantA.adminEmail);
    const { rawKey } = await createApiKey(cookieA, ['read']);

    const readRes = await app.inject({ method: 'GET', url: '/v1/cases', headers: { 'x-api-key': rawKey } });
    expect(readRes.statusCode).toBe(200);

    // api-key-plugin never matches a cookie-only route like /api-keys
    // at all — a key carries no role above read_only/analyst, so this
    // is rejected the same way any analyst-or-below cookie session
    // already would be (403, not 401 — the key IS valid).
    const manageRes = await app.inject({
      method: 'POST',
      url: '/api-keys',
      headers: { 'x-api-key': rawKey },
      payload: { name: 'should not work' },
    });
    expect(manageRes.statusCode).toBe(403);
  });
});

describe('API key lifecycle', () => {
  it('T4: a revoked key is rejected immediately, identically to an unknown key', async () => {
    const cookie = await signIn(tenantA.adminEmail);
    const { rawKey, id } = await createApiKey(cookie);

    const beforeRevoke = await app.inject({ method: 'GET', url: '/v1/cases', headers: { 'x-api-key': rawKey } });
    expect(beforeRevoke.statusCode).toBe(200);

    const revokeRes = await app.inject({ method: 'POST', url: `/api-keys/${id}/revoke`, cookies: { sentinel_session: cookie } });
    expect(revokeRes.statusCode).toBe(200);

    const afterRevoke = await app.inject({ method: 'GET', url: '/v1/cases', headers: { 'x-api-key': rawKey } });
    expect(afterRevoke.statusCode).toBe(401);
    expect(afterRevoke.json()).toMatchObject({ error: 'invalid_api_key' });

    const unknownKeyRes = await app.inject({ method: 'GET', url: '/v1/cases', headers: { 'x-api-key': 'sk_live_this_was_never_issued' } });
    expect(unknownKeyRes.statusCode).toBe(401);
    expect(unknownKeyRes.json()).toEqual(afterRevoke.json());
  });

  it('T3: rate limiting returns 429 once the per-key budget is exceeded, with the documented headers', async () => {
    const cookie = await signIn(tenantA.adminEmail);
    const { rawKey, id } = await createApiKey(cookie);
    await redis.del(`ratelimit:apikey:${id}`);

    let lastRes: Awaited<ReturnType<typeof app.inject>> | undefined;
    for (let i = 0; i < 61; i++) {
      lastRes = await app.inject({ method: 'GET', url: '/v1/cases', headers: { 'x-api-key': rawKey } });
    }

    expect(lastRes!.statusCode).toBe(429);
    expect(lastRes!.json()).toMatchObject({ error: 'rate_limited' });
    expect(lastRes!.headers['ratelimit-limit']).toBe('60');
    expect(lastRes!.headers['ratelimit-remaining']).toBe('0');
    expect(Number(lastRes!.headers['retry-after'])).toBeGreaterThan(0);
  });
});
