/**
 * P7-10 / ADR-0012 — the full HTTP round trip for /customer-rules,
 * against the real Postgres and Redis the dev stack provides.
 *
 * Unlike hotfix-rules.integration.test.ts, there is no elevated
 * ops-tenant gate to prove here — this is ordinary tenant-self-service
 * CRUD (ADR-0012 §4), so the interesting cross-tenant claim is the
 * opposite one: a tenant can only ever see/disable/delete ITS OWN
 * rules, never another tenant's, enforced by RLS the same way every
 * other tenant-scoped table already is (ADR-0008).
 *
 * The rule's own authoritative parse/validation/fixture-gated
 * activation happens in Go (services/detect/internal/customerrules),
 * exercised for real in that package's own integration tests — this
 * file proves the HTTP surface, not the Sigma semantics.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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

let tenantAId: string;
let tenantAAdminEmail: string;
let tenantAAdminUserId: string;
let tenantAReadOnlyEmail: string;

let tenantBId: string;
let tenantBAdminEmail: string;
let tenantBAdminUserId: string;

async function asAdmin<T>(fn: (client: pg.PoolClient) => Promise<T>, scopedTenantId?: string): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE sentinel_app');
    if (scopedTenantId) {
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', scopedTenantId]);
    }
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

function sampleRuleYaml(id: string): string {
  return `id: ${id}\ntitle: P7-10 probe rule\n`;
}

const SAMPLE_PAYLOAD = {
  positiveFixture: { 'metadata.operation': 'Consent to application.' },
  negativeFixture: { 'metadata.operation': 'Send' },
};

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();
  await redis.del('ratelimit:signin:ip:127.0.0.1');

  tenantAId = randomUUID();
  tenantAAdminUserId = randomUUID();
  tenantAAdminEmail = `p7-10-a-admin-${tenantAAdminUserId}@example.invalid`;
  const tenantAReadOnlyId = randomUUID();
  tenantAReadOnlyEmail = `p7-10-a-readonly-${tenantAReadOnlyId}@example.invalid`;

  tenantBId = randomUUID();
  tenantBAdminUserId = randomUUID();
  tenantBAdminEmail = `p7-10-b-admin-${tenantBAdminUserId}@example.invalid`;

  await asAdmin((c) =>
    c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3), ($4, $5, $6)', [
      tenantAId, 'P7-10 tenant A', 'trial',
      tenantBId, 'P7-10 tenant B', 'trial',
    ]),
  );
  const passwordHash = await hashPassword(KNOWN_PASSWORD);
  await asAdmin((c) =>
    c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3), ($4, $5, $3), ($6, $7, $3)', [
      tenantAAdminUserId, tenantAAdminEmail, passwordHash,
      tenantAReadOnlyId, tenantAReadOnlyEmail,
      tenantBAdminUserId, tenantBAdminEmail,
    ]),
  );
  await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [tenantAId, tenantAAdminUserId]), tenantAId);
  await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'read_only')`, [tenantAId, tenantAReadOnlyId]), tenantAId);
  await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [tenantBId, tenantBAdminUserId]), tenantBId);

  app = await buildApp({ pool, redis, cookieSecure: false });
});

afterEach(async () => {
  // customer_rules is RLS-protected (ADR-0008) — a single sentinel_app
  // transaction can only ever satisfy the USING clause for ONE tenant
  // at a time, so cleaning up both tenants' rows needs two separately
  // scoped statements, not one WHERE tenant_id = ANY(...) spanning both
  // (which FORCE ROW LEVEL SECURITY correctly refuses).
  await asAdmin((c) => c.query('DELETE FROM customer_rules WHERE tenant_id = $1', [tenantAId]), tenantAId);
  await asAdmin((c) => c.query('DELETE FROM customer_rules WHERE tenant_id = $1', [tenantBId]), tenantBId);
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = ANY($1)', [[tenantAId, tenantBId]]));
  await asAdmin((c) => c.query('DELETE FROM users WHERE id = ANY($1)', [[tenantAAdminUserId, tenantBAdminUserId]]));
  await redis.quit();
  await pool.end();
  await app.close();
});

describe('POST /customer-rules', () => {
  it('creates a customer rule as pending_validation, audit-logged', async () => {
    const cookie = await signIn(tenantAAdminEmail);
    const res = await app.inject({
      method: 'POST',
      url: '/customer-rules',
      cookies: { sentinel_session: cookie },
      payload: { ruleYaml: sampleRuleYaml('probe-create'), ...SAMPLE_PAYLOAD },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json() as { customerRule: Record<string, unknown> };
    expect(created.customerRule['ruleId']).toBe('probe-create');
    expect(created.customerRule['status']).toBe('pending_validation');
    expect(created.customerRule['tenantId']).toBe(tenantAId);

    const auditRows = await asAdmin(
      (c) => c.query(`SELECT action FROM audit_log WHERE action = 'customer_rule.create' AND subject_id = $1`, [created.customerRule['id']]),
      tenantAId,
    );
    expect(auditRows.rows).toHaveLength(1);
  });

  it('rejects a submission missing a fixture', async () => {
    const cookie = await signIn(tenantAAdminEmail);
    const res = await app.inject({
      method: 'POST',
      url: '/customer-rules',
      cookies: { sentinel_session: cookie },
      payload: { ruleYaml: sampleRuleYaml('probe-no-fixture'), positiveFixture: { a: 'b' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'negative_fixture_required' });
  });

  it('a read_only member is denied — admin is the minimum required role', async () => {
    const cookie = await signIn(tenantAReadOnlyEmail);
    const res = await app.inject({
      method: 'POST',
      url: '/customer-rules',
      cookies: { sentinel_session: cookie },
      payload: { ruleYaml: sampleRuleYaml('probe-denied'), ...SAMPLE_PAYLOAD },
    });
    expect(res.statusCode).toBe(403);
  });

  // T1's own cap, now per-tenant rather than hotfix's platform-wide one.
  it('rejects a 26th pending/active rule for the same tenant', async () => {
    const cookie = await signIn(tenantAAdminEmail);
    for (let i = 0; i < 25; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/customer-rules',
        cookies: { sentinel_session: cookie },
        payload: { ruleYaml: sampleRuleYaml(`probe-cap-${i}`), ...SAMPLE_PAYLOAD },
      });
      expect(res.statusCode).toBe(201);
    }

    const over = await app.inject({
      method: 'POST',
      url: '/customer-rules',
      cookies: { sentinel_session: cookie },
      payload: { ruleYaml: sampleRuleYaml('probe-cap-25'), ...SAMPLE_PAYLOAD },
    });
    expect(over.statusCode).toBe(409);
    expect(over.json()).toMatchObject({ error: 'customer_rule_cap_exceeded' });
  }, 30_000);

  it('rejects a request with no session', async () => {
    const res = await app.inject({ method: 'GET', url: '/customer-rules' });
    expect(res.statusCode).toBe(401);
  });
});

describe('tenant isolation (ADR-0008, applied to customer_rules)', () => {
  it("tenant B's GET /customer-rules never lists tenant A's own rule", async () => {
    const cookieA = await signIn(tenantAAdminEmail);
    const createRes = await app.inject({
      method: 'POST',
      url: '/customer-rules',
      cookies: { sentinel_session: cookieA },
      payload: { ruleYaml: sampleRuleYaml('probe-isolation'), ...SAMPLE_PAYLOAD },
    });
    const created = (createRes.json() as { customerRule: { id: string } }).customerRule;

    const cookieB = await signIn(tenantBAdminEmail);
    const listResB = await app.inject({ method: 'GET', url: '/customer-rules', cookies: { sentinel_session: cookieB } });
    const listedB = (listResB.json() as { customerRules: Array<{ id: string }> }).customerRules;
    expect(listedB.some((r) => r.id === created.id)).toBe(false);

    // The direct cross-tenant write attempt too — tenant B must not be
    // able to disable or delete tenant A's rule by id, even knowing it.
    const disableRes = await app.inject({ method: 'POST', url: `/customer-rules/${created.id}/disable`, cookies: { sentinel_session: cookieB } });
    expect(disableRes.statusCode).toBe(404);

    const deleteRes = await app.inject({ method: 'DELETE', url: `/customer-rules/${created.id}`, cookies: { sentinel_session: cookieB } });
    expect(deleteRes.statusCode).toBe(404);

    const listResA = await app.inject({ method: 'GET', url: '/customer-rules', cookies: { sentinel_session: cookieA } });
    const listedA = (listResA.json() as { customerRules: Array<{ id: string; status: string }> }).customerRules;
    expect(listedA.find((r) => r.id === created.id)?.status).toBe('pending_validation');
  });
});

describe('POST /customer-rules/:id/disable and DELETE /customer-rules/:id', () => {
  it("a tenant's own admin can disable, then delete, its own rule", async () => {
    const cookie = await signIn(tenantAAdminEmail);
    const createRes = await app.inject({
      method: 'POST',
      url: '/customer-rules',
      cookies: { sentinel_session: cookie },
      payload: { ruleYaml: sampleRuleYaml('probe-lifecycle'), ...SAMPLE_PAYLOAD },
    });
    const created = (createRes.json() as { customerRule: { id: string } }).customerRule;

    const disableRes = await app.inject({ method: 'POST', url: `/customer-rules/${created.id}/disable`, cookies: { sentinel_session: cookie } });
    expect(disableRes.statusCode).toBe(200);
    expect((disableRes.json() as { customerRule: { status: string } }).customerRule.status).toBe('disabled');

    const deleteRes = await app.inject({ method: 'DELETE', url: `/customer-rules/${created.id}`, cookies: { sentinel_session: cookie } });
    expect(deleteRes.statusCode).toBe(200);

    const listRes = await app.inject({ method: 'GET', url: '/customer-rules', cookies: { sentinel_session: cookie } });
    const listed = (listRes.json() as { customerRules: Array<{ id: string }> }).customerRules;
    expect(listed.some((r) => r.id === created.id)).toBe(false);
  });
});
