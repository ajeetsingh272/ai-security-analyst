/**
 * P5-09 AC5/T4 — the HTTP surface for /audit/export against real
 * Postgres and Redis. AuditExportRepository's own range-correctness
 * (every entry inside [from, to), nothing outside) is already proven
 * directly in packages/db's own audit-export-repository.integration.test.ts;
 * this file proves the ROUTE wiring — role gating, date validation,
 * and that a real approval produces an export a compliance reviewer
 * could actually use.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import pg from 'pg';
import { PreApprovalRepository, withTenantContext } from '@sentinel/db';
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
  app = await buildApp({ pool, redis, cookieSecure: false });

  tenantId = randomUUID();
  adminUserId = randomUUID();
  adminEmail = `p5-09-admin-${adminUserId}@example.invalid`;
  readOnlyUserId = randomUUID();
  readOnlyEmail = `p5-09-readonly-${readOnlyUserId}@example.invalid`;

  await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [tenantId, 'P5-09 audit export probe', 'trial']));
  const passwordHash = await hashPassword(KNOWN_PASSWORD);
  await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [adminUserId, adminEmail, passwordHash]));
  await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [readOnlyUserId, readOnlyEmail, passwordHash]));
  await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [tenantId, adminUserId]), tenantId);
  await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'read_only')`, [tenantId, readOnlyUserId]), tenantId);

  // A real, auditable action — PreApprovalRepository.grant writes its
  // own audit entry, so there is genuine audit history to export.
  await withTenantContext(tenantId, () => new PreApprovalRepository(pool).grant('revoke_sessions', adminUserId));
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  await app.close();
  await redis.quit();
  await pool.end();
});

describe('GET /audit/export', () => {
  it('a read_only member is refused', async () => {
    const cookie = await signIn(readOnlyEmail);
    const res = await app.inject({ method: 'GET', url: '/audit/export?from=2026-01-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z', cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a missing or malformed date range', async () => {
    const cookie = await signIn(adminEmail);
    const missing = await app.inject({ method: 'GET', url: '/audit/export', cookies: { sentinel_session: cookie } });
    expect(missing.statusCode).toBe(400);

    const malformed = await app.inject({ method: 'GET', url: '/audit/export?from=not-a-date&to=2026-12-31T00:00:00.000Z', cookies: { sentinel_session: cookie } });
    expect(malformed.statusCode).toBe(400);

    const backwards = await app.inject({ method: 'GET', url: '/audit/export?from=2026-12-31T00:00:00.000Z&to=2026-01-01T00:00:00.000Z', cookies: { sentinel_session: cookie } });
    expect(backwards.statusCode).toBe(400);
  });

  it("T4: an admin's export contains this tenant's own real audit entry (pre-approval grant)", async () => {
    const cookie = await signIn(adminEmail);
    const res = await app.inject({ method: 'GET', url: '/audit/export?from=2020-01-01T00:00:00.000Z&to=2030-01-01T00:00:00.000Z', cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.count).toBeGreaterThanOrEqual(1);
    expect(body.entries.some((e: { action: string; actorId: string }) => e.action === 'pre_approval_granted' && e.actorId === adminUserId)).toBe(true);
  });

  it('a date range that excludes the entry returns an export with count 0', async () => {
    const cookie = await signIn(adminEmail);
    const res = await app.inject({ method: 'GET', url: '/audit/export?from=1999-01-01T00:00:00.000Z&to=1999-01-02T00:00:00.000Z', cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ from: '1999-01-01T00:00:00.000Z', to: '1999-01-02T00:00:00.000Z', count: 0, entries: [] });
  });
});
