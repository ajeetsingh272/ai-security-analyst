/**
 * P6-05 T2/T3/T4 — the full HTTP round trip for POST /scan, GET
 * /scan/:id and POST /scan/:id/share, against the real Postgres and
 * Redis the dev stack provides.
 *
 * T1 (a real 100-seat tenant scans in under 10 minutes) is NOT
 * exercised here — there is no real M365 tenant or replay trigger in
 * this sandbox (see 0024_scan_jobs.sql's own doc comment for the full,
 * disclosed scope boundary). What IS real: every case this route
 * itself controls — the business-language summary, the honest clean
 * result, and the audit-log-backed funnel.
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

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel' });
let redis: RedisClientType;
let app: FastifyInstance;

const KNOWN_PASSWORD = 'correct horse battery staple';
let tenantId: string;
let adminEmail: string;
let readOnlyEmail: string;

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

/** `daysAgo` lets a test place a case inside or outside the scan's own
 * 7-day window without racing the real clock. */
async function seedCase(severity: string, title: string, daysAgo: number): Promise<string> {
  return asAdmin(async (client) => {
    const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count, entity_ids, created_at)
       VALUES ($1, $2, $3, $4, 1, ARRAY[$5]::text[], $4) RETURNING id`,
      [tenantId, severity, title, createdAt, randomUUID()],
    );
    const caseId = rows[0]!.id;
    await client.query(
      `INSERT INTO case_transitions (tenant_id, case_id, from_state, to_state, actor_type, actor_id, reason, occurred_at)
       VALUES ($1, $2, NULL, 'open', 'system', 'correlate', 'first signal clustered', $3)`,
      [tenantId, caseId, createdAt],
    );
    return caseId;
  }, tenantId);
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

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();
  await redis.del('ratelimit:signin:ip:127.0.0.1');

  tenantId = randomUUID();
  const adminId = randomUUID();
  adminEmail = `p6-05-admin-${adminId}@example.invalid`;
  readOnlyEmail = `p6-05-readonly-${randomUUID()}@example.invalid`;

  await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [tenantId, 'P6-05 probe tenant', 'trial']));
  const passwordHash = await hashPassword(KNOWN_PASSWORD);
  await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [adminId, adminEmail, passwordHash]));
  const readOnlyId = randomUUID();
  await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [readOnlyId, readOnlyEmail, passwordHash]));
  await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [tenantId, adminId]), tenantId);
  await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'read_only')`, [tenantId, readOnlyId]), tenantId);

  app = await buildApp({ pool, redis, cookieSecure: false });
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  await asAdmin((c) => c.query("DELETE FROM users WHERE email LIKE 'p6-05-%@example.invalid'"));
  await redis.quit();
  await pool.end();
  await app.close();
});

describe('POST /scan', () => {
  it('T2: a tenant with known serious issues surfaces exactly those issues, in business language', async () => {
    const criticalId = await seedCase('critical', 'Impossible travel for a finance admin', 1);
    const lowId = await seedCase('low', 'Routine sign-in from a known device', 1);
    const outsideWindowId = await seedCase('critical', 'Outside the scan window entirely', 30); // must NOT appear

    const cookie = await signIn(adminEmail);
    const res = await app.inject({ method: 'POST', url: '/scan', cookies: { sentinel_session: cookie } });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      scanId: string;
      totalFindings: number;
      entitiesAffected: number;
      isClean: boolean;
      headline: string;
      findings: Array<{ id: string }>;
    };

    const foundIds = body.findings.map((f) => f.id);
    expect(foundIds).toContain(criticalId);
    expect(foundIds).toContain(lowId);
    expect(foundIds).not.toContain(outsideWindowId);
    expect(body.isClean).toBe(false);
    expect(body.headline).toMatch(/need.*attention/);
    expect(body.entitiesAffected).toBeGreaterThan(0);
  });

  it('T3: a tenant with no serious findings gets an honest clean result, inventing nothing', async () => {
    // Deliberately its OWN fresh tenant, not the shared one above — T2
    // already left a critical case inside THAT tenant's own 7-day
    // window, which would make this tenant's own result dishonestly
    // non-clean if it reused it. A clean result has to mean a tenant
    // with nothing serious, not "whichever tenant a test happened to
    // run against."
    const cleanTenantId = randomUUID();
    const cleanAdminId = randomUUID();
    const cleanAdminEmail = `p6-05-clean-${cleanAdminId}@example.invalid`;
    await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [cleanTenantId, 'P6-05 clean probe tenant', 'trial']));
    const passwordHash = await hashPassword(KNOWN_PASSWORD);
    await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [cleanAdminId, cleanAdminEmail, passwordHash]));
    await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [cleanTenantId, cleanAdminId]), cleanTenantId);
    await asAdmin(
      async (client) => {
        const createdAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await client.query(
          `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count, created_at) VALUES ($1, 'info', 'Nothing more than routine activity', $2, 1, $2)`,
          [cleanTenantId, createdAt],
        );
      },
      cleanTenantId,
    );

    const cookie = await signIn(cleanAdminEmail);
    const res = await app.inject({ method: 'POST', url: '/scan', cookies: { sentinel_session: cookie } });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { isClean: boolean; headline: string };
    expect(body.isClean).toBe(true);
    expect(body.headline).toMatch(/Nothing serious/);
    expect(body.headline).not.toMatch(/urgent|immediately|critical|act now/i);

    await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [cleanTenantId]));
    await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [cleanAdminId]));
  });

  it('rejects a read_only member — admin is the minimum required role', async () => {
    const cookie = await signIn(readOnlyEmail);
    const res = await app.inject({ method: 'POST', url: '/scan', cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(403);
  });

  it('T4: records a real, queryable funnel entry for each step', async () => {
    const cookie = await signIn(adminEmail);
    const startRes = await app.inject({ method: 'POST', url: '/scan', cookies: { sentinel_session: cookie } });
    const { scanId } = startRes.json() as { scanId: string };

    await app.inject({ method: 'GET', url: `/scan/${scanId}`, cookies: { sentinel_session: cookie } });
    await app.inject({ method: 'POST', url: `/scan/${scanId}/share`, cookies: { sentinel_session: cookie } });

    const audit = await asAdmin(
      (c) => c.query<{ action: string }>(`SELECT action FROM audit_log WHERE subject_type = 'scan_job' AND subject_id = $1 ORDER BY id ASC`, [scanId]),
      tenantId,
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['scan.started', 'scan.completed', 'scan.viewed', 'scan.report_shared']);
  });
});

describe('GET /scan/:id', () => {
  it('a read_only member can view an existing scan report', async () => {
    const adminCookie = await signIn(adminEmail);
    const startRes = await app.inject({ method: 'POST', url: '/scan', cookies: { sentinel_session: adminCookie } });
    const { scanId } = startRes.json() as { scanId: string };

    const cookie = await signIn(readOnlyEmail);
    const res = await app.inject({ method: 'GET', url: `/scan/${scanId}`, cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().scanId).toBe(scanId);
  });

  it('returns 404 for a scan that does not exist', async () => {
    const cookie = await signIn(readOnlyEmail);
    const res = await app.inject({ method: 'GET', url: `/scan/${randomUUID()}`, cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(404);
  });
});
