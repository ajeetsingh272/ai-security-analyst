/**
 * P6-02 — the full HTTP round trip for GET /cases and GET
 * /cases/filter-options, against the real Postgres and Redis the dev
 * stack provides. Mirrors dismissals.integration.test.ts's own fixture
 * pattern.
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
let tenantId: string;
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

async function seedCase(severity: string, title: string): Promise<string> {
  return asAdmin(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count) VALUES ($1, $2, $3, now(), 1) RETURNING id`,
      [tenantId, severity, title],
    );
    const caseId = rows[0]!.id;
    await client.query(
      `INSERT INTO case_transitions (tenant_id, case_id, from_state, to_state, actor_type, actor_id, reason)
       VALUES ($1, $2, NULL, 'open', 'system', 'correlate', 'first signal clustered')`,
      [tenantId, caseId],
    );
    return caseId;
  }, tenantId);
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
  readOnlyUserId = randomUUID();
  readOnlyEmail = `p6-02-readonly-${readOnlyUserId}@example.invalid`;

  await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [tenantId, 'P6-02 probe tenant', 'trial']));
  const passwordHash = await hashPassword(KNOWN_PASSWORD);
  await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [readOnlyUserId, readOnlyEmail, passwordHash]));
  await asAdmin(
    (c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'read_only')`, [tenantId, readOnlyUserId]),
    tenantId,
  );

  app = await buildApp({ pool, redis, cookieSecure: false });
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [readOnlyUserId]));
  await redis.quit();
  await pool.end();
  await app.close();
});

describe('GET /cases', () => {
  it('a read_only member can list cases, ranked by severity', async () => {
    const criticalId = await seedCase('critical', 'P6-02 critical probe');
    const lowId = await seedCase('low', 'P6-02 low probe');

    const cookie = await signIn(readOnlyEmail);
    const res = await app.inject({ method: 'GET', url: '/cases', cookies: { sentinel_session: cookie } });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ id: string; severity: string }>; total: number; page: number; pageSize: number };
    const ids = body.items.map((i) => i.id);
    expect(ids.indexOf(criticalId)).toBeLessThan(ids.indexOf(lowId));
    expect(body.page).toBe(1);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/cases' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an invalid severity filter with 400', async () => {
    const cookie = await signIn(readOnlyEmail);
    const res = await app.inject({ method: 'GET', url: '/cases?severity=not-a-real-severity', cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_severity');
  });

  it('filters by severity', async () => {
    const criticalId = await seedCase('critical', 'P6-02 filter probe critical');
    const cookie = await signIn(readOnlyEmail);
    const res = await app.inject({ method: 'GET', url: '/cases?severity=critical', cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ id: string; severity: string }> };
    expect(body.items.every((i) => i.severity === 'critical')).toBe(true);
    expect(body.items.map((i) => i.id)).toContain(criticalId);
  });

  it('caps pageSize at 100 rather than erroring', async () => {
    const cookie = await signIn(readOnlyEmail);
    const res = await app.inject({ method: 'GET', url: '/cases?pageSize=99999', cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().pageSize).toBe(100);
  });
});

describe('GET /cases/filter-options', () => {
  it('returns entity and rule filter options', async () => {
    const cookie = await signIn(readOnlyEmail);
    const res = await app.inject({ method: 'GET', url: '/cases/filter-options', cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entities: unknown[]; rules: unknown[] };
    expect(Array.isArray(body.entities)).toBe(true);
    expect(Array.isArray(body.rules)).toBe(true);
  });
});
