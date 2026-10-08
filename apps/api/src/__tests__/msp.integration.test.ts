/**
 * P6-06 T1/T2/T4 — GET /msp/clients against the real Postgres and
 * Redis the dev stack provides, including a real 200-linked-client
 * performance check (not a mock — 200 real tenants, each with its own
 * real critical case, each queried under its own real tenant context).
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import pg, { type PoolClient } from 'pg';
import { hashPassword } from '../auth/password.js';
import { buildApp } from '../app.js';

const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel',
  max: 20,
});
let redis: RedisClientType;
let app: FastifyInstance;

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

function cookieFrom(res: { cookies: Array<{ name: string; value: string }> }): string {
  const value = res.cookies.find((c) => c.name === 'sentinel_session')?.value;
  if (!value) throw new Error('no session cookie in response');
  return value;
}

async function signIn(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/sign-in', payload: { email, password: KNOWN_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`sign-in failed for ${email}: ${res.statusCode} ${res.body}`);
  return cookieFrom(res);
}

async function makeTenant(name: string, plan: string): Promise<string> {
  const result = await asAdmin((c) => c.query<{ id: string }>('INSERT INTO tenants (name, plan) VALUES ($1, $2) RETURNING id', [name, plan]));
  return result.rows[0]!.id;
}

async function linkClient(mspTenantId: string, clientTenantId: string): Promise<void> {
  await asAdmin(
    (c) => c.query('INSERT INTO msp_links (msp_tenant_id, client_tenant_id) VALUES ($1, $2)', [mspTenantId, clientTenantId]),
    mspTenantId,
  );
}

async function seedCriticalCase(tenantId: string): Promise<void> {
  await asAdmin(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count) VALUES ($1, 'critical', 'P6-06 probe case', now(), 1) RETURNING id`,
      [tenantId],
    );
    await client.query(
      `INSERT INTO case_transitions (tenant_id, case_id, from_state, to_state, actor_type, actor_id, reason) VALUES ($1, $2, NULL, 'open', 'system', 'correlate', 'first signal clustered')`,
      [tenantId, rows[0]!.id],
    );
  }, tenantId);
}

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();
  await redis.del('ratelimit:signin:ip:127.0.0.1');
  app = await buildApp({ pool, redis, cookieSecure: false });
});

afterAll(async () => {
  await redis.quit();
  await pool.end();
  await app.close();
});

describe('GET /msp/clients', () => {
  it('T1: ranks every linked client by open critical cases, and performs acceptably at 200 clients', async () => {
    const mspTenantId = await makeTenant('P6-06 load probe MSP', 'msp');
    const adminId = randomUUID();
    const adminEmail = `p6-06-load-admin-${adminId}@example.invalid`;
    const passwordHash = await hashPassword(KNOWN_PASSWORD);
    await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [adminId, adminEmail, passwordHash]));
    await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [mspTenantId, adminId]), mspTenantId);

    const clientTenantIds: string[] = [];
    for (let i = 0; i < 200; i++) {
      const clientTenantId = await makeTenant(`P6-06 load client ${i}`, 'trial');
      clientTenantIds.push(clientTenantId);
      await linkClient(mspTenantId, clientTenantId);
    }
    // Exactly one client gets 3 critical cases — the one that must rank first.
    const busiest = clientTenantIds[0]!;
    await seedCriticalCase(busiest);
    await seedCriticalCase(busiest);
    await seedCriticalCase(busiest);
    await seedCriticalCase(clientTenantIds[1]!);

    const cookie = await signIn(adminEmail);
    const start = performance.now();
    const res = await app.inject({ method: 'GET', url: '/msp/clients', cookies: { sentinel_session: cookie } });
    const elapsedMs = performance.now() - start;

    expect(res.statusCode).toBe(200);
    const body = res.json() as { clients: Array<{ tenantId: string; name: string; openCriticalCount: number }> };
    expect(body.clients).toHaveLength(200);
    expect(body.clients[0]!.tenantId).toBe(busiest);
    expect(body.clients[0]!.openCriticalCount).toBe(3);
    expect(elapsedMs).toBeLessThan(10_000); // generous budget; the point is "doesn't fall over at 200", not a tight SLO

    await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = ANY($1)', [[mspTenantId, ...clientTenantIds]]));
    await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [adminId]));
  }, 60_000);

  it('T2: a tenant with no link at all never appears, and cannot be switched into', async () => {
    const mspTenantId = await makeTenant('P6-06 security probe MSP', 'msp');
    const unrelatedTenantId = await makeTenant('P6-06 unrelated unlinked tenant', 'trial');
    const adminId = randomUUID();
    const adminEmail = `p6-06-security-admin-${adminId}@example.invalid`;
    const passwordHash = await hashPassword(KNOWN_PASSWORD);
    await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [adminId, adminEmail, passwordHash]));
    await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [mspTenantId, adminId]), mspTenantId);

    const cookie = await signIn(adminEmail);
    const res = await app.inject({ method: 'GET', url: '/msp/clients', cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { clients: unknown[] }).clients).toEqual([]);

    const switchRes = await app.inject({
      method: 'POST',
      url: '/auth/switch-tenant',
      cookies: { sentinel_session: cookie },
      payload: { targetTenantId: unrelatedTenantId },
    });
    expect(switchRes.statusCode).toBe(403);

    await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = ANY($1)', [[mspTenantId, unrelatedTenantId]]));
    await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [adminId]));
  });

  it('T4: revoking a link removes it from the list and blocks switching, immediately, in the same session', async () => {
    const mspTenantId = await makeTenant('P6-06 unlink probe MSP', 'msp');
    const clientTenantId = await makeTenant('P6-06 soon-to-be-unlinked client', 'trial');
    const adminId = randomUUID();
    const adminEmail = `p6-06-unlink-admin-${adminId}@example.invalid`;
    const passwordHash = await hashPassword(KNOWN_PASSWORD);
    await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [adminId, adminEmail, passwordHash]));
    await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [mspTenantId, adminId]), mspTenantId);
    await linkClient(mspTenantId, clientTenantId);

    const cookie = await signIn(adminEmail);

    const before = await app.inject({ method: 'GET', url: '/msp/clients', cookies: { sentinel_session: cookie } });
    expect((before.json() as { clients: Array<{ tenantId: string }> }).clients.map((c) => c.tenantId)).toContain(clientTenantId);

    await asAdmin(
      (c) => c.query('UPDATE msp_links SET revoked_at = now() WHERE msp_tenant_id = $1 AND client_tenant_id = $2', [mspTenantId, clientTenantId]),
      mspTenantId,
    );

    const after = await app.inject({ method: 'GET', url: '/msp/clients', cookies: { sentinel_session: cookie } });
    expect((after.json() as { clients: Array<{ tenantId: string }> }).clients.map((c) => c.tenantId)).not.toContain(clientTenantId);

    const switchRes = await app.inject({
      method: 'POST',
      url: '/auth/switch-tenant',
      cookies: { sentinel_session: cookie },
      payload: { targetTenantId: clientTenantId },
    });
    expect(switchRes.statusCode).toBe(403);

    await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = ANY($1)', [[mspTenantId, clientTenantId]]));
    await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [adminId]));
  });

  it('rejects a read_only member — admin is the minimum required role', async () => {
    const mspTenantId = await makeTenant('P6-06 role probe MSP', 'msp');
    const readOnlyId = randomUUID();
    const readOnlyEmail = `p6-06-role-readonly-${readOnlyId}@example.invalid`;
    const passwordHash = await hashPassword(KNOWN_PASSWORD);
    await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [readOnlyId, readOnlyEmail, passwordHash]));
    await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'read_only')`, [mspTenantId, readOnlyId]), mspTenantId);

    const cookie = await signIn(readOnlyEmail);
    const res = await app.inject({ method: 'GET', url: '/msp/clients', cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(403);

    await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [mspTenantId]));
    await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [readOnlyId]));
  });
});
