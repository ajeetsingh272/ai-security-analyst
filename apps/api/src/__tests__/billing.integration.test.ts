/**
 * P6-10 — against the real Postgres and Redis the dev stack provides.
 * Email sends are verified against a mocked global `fetch` (same
 * precedent as packages/notifications/src/__tests__/email-channel.
 * test.ts — no real Resend API key or verified domain exists in this
 * sandbox), not a real network call.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import pg from 'pg';
import { withTenantContext, TenantUsageRepository, listTenantUsageSummaries } from '@sentinel/db';
import { hashPassword } from '../auth/password.js';
import { buildApp } from '../app.js';
import { runPlanUsageSweep } from '../plan-usage-sweep.js';
import { runWeeklyReportSweep } from '../weekly-report-scheduler.js';

const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel',
});
let redis: RedisClientType;

function recipientsCalledOn(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.map((call) => JSON.parse((call[1] as { body: string }).body).to as string);
}

const KNOWN_PASSWORD = 'correct horse battery staple';
const testLogger = { info: () => {}, error: () => {} };
const RESEND_CONFIG = { apiKey: 're_test_key', fromAddress: 'alerts@sentinel.example', apiBaseUrl: 'https://example.invalid' };

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

async function makeTenant(plan: string, label: string): Promise<{ tenantId: string; userIds: string[] }> {
  const tenantId = randomUUID();
  await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [tenantId, `P6-10 ${label}`, plan]));
  return { tenantId, userIds: [] };
}

async function addMemberships(tenantId: string, count: number, role: 'owner' | 'admin' | 'read_only' = 'read_only'): Promise<string[]> {
  const userIds: string[] = [];
  const passwordHash = await hashPassword(KNOWN_PASSWORD);
  for (let i = 0; i < count; i++) {
    const userId = randomUUID();
    const email = `p6-10-member-${userId}@example.invalid`;
    await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [userId, email, passwordHash]));
    await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)`, [tenantId, userId, i === 0 ? role : 'read_only']), tenantId);
    userIds.push(userId);
  }
  return userIds;
}

/** Bulk-inserts N case_signals in one round trip via generate_series —
 * seeding thousands of rows one-by-one would be needlessly slow for a
 * hard-exceeded event-volume test. */
async function seedEventVolume(tenantId: string, count: number): Promise<void> {
  await asAdmin(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count) VALUES ($1, 'low', 'volume probe case', now(), $2) RETURNING id`,
      [tenantId, count],
    );
    const caseId = rows[0]!.id;
    await client.query(
      `INSERT INTO case_signals (tenant_id, case_id, dedupe_key, signal_id, rule_id, entity_type, entity_id, severity, detected_at)
       SELECT $1, $2, 'dedupe-' || gs, 'signal-' || gs, 'rule-probe', 'user', 'entity-' || gs, 'low', now()
       FROM generate_series(1, $3) AS gs`,
      [tenantId, caseId, count],
    );
  }, tenantId);
}

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();
});

afterAll(async () => {
  await redis.quit();
  await pool.end();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TenantUsageRepository (T1: usage metering matches actual consumption)', () => {
  let tenantId: string;

  beforeAll(async () => {
    ({ tenantId } = await makeTenant('startup', 'metering tenant'));
    await addMemberships(tenantId, 4);
    await seedEventVolume(tenantId, 7);
  });

  afterAll(async () => {
    await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  });

  it('counts exactly the seats and event volume actually seeded, not an approximation', async () => {
    const [seatCount, eventVolume] = await withTenantContext(tenantId, async () => {
      const repo = new TenantUsageRepository(pool);
      return Promise.all([repo.countSeats(), repo.countEventVolumeSince(new Date(Date.now() - 24 * 60 * 60 * 1000))]);
    });
    expect(seatCount).toBe(4);
    expect(eventVolume).toBe(7);
  });

  it('the cross-tenant ops summary reports the same counts', async () => {
    const summaries = await listTenantUsageSummaries(pool);
    const mine = summaries.find((s) => s.tenantId === tenantId);
    expect(mine).toBeDefined();
    expect(mine!.seatCount).toBe(4);
    expect(mine!.eventVolume).toBe(7);
  });
});

describe('runPlanUsageSweep (T2: exceeding a plan limit degrades gracefully and notifies)', () => {
  let hardTenantId: string;
  let softTenantId: string;
  let softOwnerEmail: string;

  let hardOwnerEmail: string;

  beforeAll(async () => {
    const hard = await makeTenant('trial', 'hard-exceeded tenant');
    hardTenantId = hard.tenantId;
    // trial's eventVolumePerDay hardCap is 1,500 — comfortably over it.
    await seedEventVolume(hardTenantId, 2_000);
    // A real recipient is required so "the email was not sent" proves
    // the degrade check actually fired, rather than trivially passing
    // because there was no one to email regardless.
    hardOwnerEmail = `p6-10-hard-owner-${randomUUID()}@example.invalid`;
    const hardOwnerId = randomUUID();
    const hardOwnerPasswordHash = await hashPassword(KNOWN_PASSWORD);
    await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [hardOwnerId, hardOwnerEmail, hardOwnerPasswordHash]));
    await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`, [hardTenantId, hardOwnerId]), hardTenantId);

    const soft = await makeTenant('small_business', 'soft-exceeded tenant');
    softTenantId = soft.tenantId;
    softOwnerEmail = `p6-10-owner-${randomUUID()}@example.invalid`;
    const ownerUserId = randomUUID();
    const passwordHash = await hashPassword(KNOWN_PASSWORD);
    await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [ownerUserId, softOwnerEmail, passwordHash]));
    await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`, [softTenantId, ownerUserId]), softTenantId);
    // small_business seats allowance is 15 (soft threshold 22.5) — 23 more read_only members crosses it, stays under hardCap 30.
    await addMemberships(softTenantId, 23);
  });

  afterAll(async () => {
    await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [hardTenantId]));
    await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [softTenantId]));
  });

  it('a tenant hard-exceeding event volume is recorded as hard_exceeded', async () => {
    await runPlanUsageSweep(pool, undefined, testLogger);
    const status = await withTenantContext(hardTenantId, () => new TenantUsageRepository(pool).getStatus());
    expect(status?.eventVolumeStatus).toBe('hard_exceeded');
  });

  it("degrades gracefully: the hard-exceeded tenant's weekly report still generates, but its email is paused", async () => {
    await asAdmin((c) => c.query(`INSERT INTO tenant_report_schedule (tenant_id, day_of_week, enabled) VALUES ($1, $2, true)`, [hardTenantId, new Date().getUTCDay()]), hardTenantId);

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'email_should_not_be_sent' }) });
    vi.stubGlobal('fetch', fetchMock);

    await runWeeklyReportSweep(pool, RESEND_CONFIG, testLogger);

    // Filters by recipient rather than a blanket "never called": other
    // active tenants in the shared dev database may ALSO be due today
    // (the default schedule is Monday, enabled) and legitimately send
    // their own, unrelated report email in the same sweep.
    expect(recipientsCalledOn(fetchMock)).not.toContain(hardOwnerEmail);
    const reportRows = await asAdmin((c) => c.query('SELECT id FROM weekly_reports WHERE tenant_id = $1', [hardTenantId]), hardTenantId);
    expect(reportRows.rows.length).toBeGreaterThan(0);
  });

  it('a tenant newly crossing into soft_exceeded is notified exactly once, not on every sweep', async () => {
    // Filters by recipient rather than asserting a total call count:
    // this sweep evaluates EVERY active tenant in the shared dev
    // database, not only this test's own two, so other tenants
    // escalating (or not) on the same sweep must not make this
    // assertion flaky either way.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'email_abc' }) });
    vi.stubGlobal('fetch', fetchMock);

    await runPlanUsageSweep(pool, RESEND_CONFIG, testLogger);

    const status = await withTenantContext(softTenantId, () => new TenantUsageRepository(pool).getStatus());
    expect(status?.seatsStatus).toBe('soft_exceeded');
    expect(status?.softNotifiedAt).not.toBeNull();
    expect(recipientsCalledOn(fetchMock).filter((to) => to === softOwnerEmail)).toHaveLength(1);

    // Running the sweep again while STILL soft_exceeded (no new
    // crossing) must not notify this tenant a second time.
    fetchMock.mockClear();
    await runPlanUsageSweep(pool, RESEND_CONFIG, testLogger);
    expect(recipientsCalledOn(fetchMock)).not.toContain(softOwnerEmail);
  });
});

describe('GET /ops/margin', () => {
  let app: FastifyInstance;
  let opsTenantId: string;
  let opsAdminEmail: string;
  let customerTenantId: string;

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
    const ops = await makeTenant('msp', 'ops tenant');
    opsTenantId = ops.tenantId;
    opsAdminEmail = `p6-10-ops-admin-${randomUUID()}@example.invalid`;
    const adminUserId = randomUUID();
    const passwordHash = await hashPassword(KNOWN_PASSWORD);
    await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [adminUserId, opsAdminEmail, passwordHash]));
    await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [opsTenantId, adminUserId]), opsTenantId);

    const customer = await makeTenant('startup', 'ops-view customer tenant');
    customerTenantId = customer.tenantId;
    await addMemberships(customerTenantId, 2);

    app = await buildApp({ pool, redis, cookieSecure: false, opsTenantId });
  });

  afterAll(async () => {
    await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [opsTenantId]));
    await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [customerTenantId]));
    await app.close();
  });

  it("an admin of the designated ops tenant sees every tenant's margin, including startup pricing", async () => {
    const cookie = await signIn(opsAdminEmail);
    const res = await app.inject({ method: 'GET', url: '/ops/margin', cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tenants: Array<{ tenantId: string; plan: string; revenueUsd: number; marginUsd: number }> };
    const mine = body.tenants.find((t) => t.tenantId === customerTenantId);
    expect(mine).toBeDefined();
    expect(mine!.plan).toBe('startup');
    expect(mine!.revenueUsd).toBe(200);
  });

  it("an admin of a CUSTOMER tenant (not the ops tenant) is refused, even though they are genuinely admin somewhere", async () => {
    const customerAdminEmail = `p6-10-customer-admin-${randomUUID()}@example.invalid`;
    const customerAdminId = randomUUID();
    const passwordHash = await hashPassword(KNOWN_PASSWORD);
    await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [customerAdminId, customerAdminEmail, passwordHash]));
    await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [customerTenantId, customerAdminId]), customerTenantId);

    const cookie = await signIn(customerAdminEmail);
    const res = await app.inject({ method: 'GET', url: '/ops/margin', cookies: { sentinel_session: cookie } });
    expect(res.statusCode).toBe(403);
  });
});
