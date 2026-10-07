/**
 * P2-12 — the full HTTP round trip for /hotfix-rules, against the real
 * Postgres and Redis the dev stack provides.
 *
 * T1 ("an 11th hotfix rule is rejected") and T3 ("creation by a
 * non-elevated role is denied and audited") get their end-to-end proof
 * here. T3 specifically covers the architecturally important case this
 * route's own design exists for: a CUSTOMER tenant's own admin — full
 * admin rank, just the wrong tenant — must be denied exactly like an
 * under-ranked user would be, and the denial must be audited.
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

let opsTenantId: string;
let opsAdminUserId: string;
let opsAdminEmail: string;
let opsAnalystUserId: string;
let opsAnalystEmail: string;

let customerTenantId: string;
let customerAdminUserId: string;
let customerAdminEmail: string;

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
  return `id: ${id}\ntitle: P2-12 probe rule\n`;
}

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();
  await redis.del('ratelimit:signin:ip:127.0.0.1');

  opsTenantId = randomUUID();
  opsAdminUserId = randomUUID();
  opsAdminEmail = `p2-12-ops-admin-${opsAdminUserId}@example.invalid`;
  opsAnalystUserId = randomUUID();
  opsAnalystEmail = `p2-12-ops-analyst-${opsAnalystUserId}@example.invalid`;
  customerTenantId = randomUUID();
  customerAdminUserId = randomUUID();
  customerAdminEmail = `p2-12-customer-admin-${customerAdminUserId}@example.invalid`;

  await asAdmin((c) =>
    c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3), ($4, $5, $6)', [
      opsTenantId, 'P2-12 ops tenant', 'trial',
      customerTenantId, 'P2-12 customer tenant', 'trial',
    ]),
  );
  const passwordHash = await hashPassword(KNOWN_PASSWORD);
  await asAdmin((c) =>
    c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3), ($4, $5, $3), ($6, $7, $3)', [
      opsAdminUserId, opsAdminEmail, passwordHash,
      opsAnalystUserId, opsAnalystEmail,
      customerAdminUserId, customerAdminEmail,
    ]),
  );
  await asAdmin(
    (c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [opsTenantId, opsAdminUserId]),
    opsTenantId,
  );
  await asAdmin(
    (c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'analyst')`, [opsTenantId, opsAnalystUserId]),
    opsTenantId,
  );
  await asAdmin(
    (c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [customerTenantId, customerAdminUserId]),
    customerTenantId,
  );

  app = await buildApp({ pool, redis, cookieSecure: false, opsTenantId });
});

afterEach(async () => {
  await asAdmin((c) => c.query('DELETE FROM hotfix_rules'));
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = ANY($1)', [[opsTenantId, customerTenantId]]));
  await asAdmin((c) =>
    c.query('DELETE FROM users WHERE id = ANY($1)', [[opsAdminUserId, opsAnalystUserId, customerAdminUserId]]),
  );
  await redis.quit();
  await pool.end();
  await app.close();
});

describe('POST /hotfix-rules', () => {
  it('creates a hotfix rule, audit-logs it, and lists it as active', async () => {
    const cookie = await signIn(opsAdminEmail);
    const createRes = await app.inject({
      method: 'POST',
      url: '/hotfix-rules',
      cookies: { sentinel_session: cookie },
      payload: { ruleYaml: sampleRuleYaml('probe-create'), reason: 'customer actively exploited, no time for a normal release' },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json() as { hotfixRule: Record<string, unknown> };
    expect(created.hotfixRule['ruleId']).toBe('probe-create');

    const auditRows = await asAdmin(
      (c) => c.query(`SELECT action FROM audit_log WHERE action = 'hotfix_rule.create' AND subject_id = $1`, [created.hotfixRule['id']]),
      opsTenantId,
    );
    expect(auditRows.rows).toHaveLength(1);

    const listRes = await app.inject({ method: 'GET', url: '/hotfix-rules', cookies: { sentinel_session: cookie } });
    expect(listRes.statusCode).toBe(200);
    const listed = (listRes.json() as { hotfixRules: Array<Record<string, unknown>> }).hotfixRules;
    expect(listed.some((r) => r['id'] === created.hotfixRule['id'])).toBe(true);
  });

  // T1: "An 11th hotfix rule is rejected."
  it('T1: rejects an 11th active hotfix rule', async () => {
    const cookie = await signIn(opsAdminEmail);
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/hotfix-rules',
        cookies: { sentinel_session: cookie },
        payload: { ruleYaml: sampleRuleYaml(`probe-cap-${i}`), reason: 'filling the cap for T1' },
      });
      expect(res.statusCode).toBe(201);
    }

    const eleventh = await app.inject({
      method: 'POST',
      url: '/hotfix-rules',
      cookies: { sentinel_session: cookie },
      payload: { ruleYaml: sampleRuleYaml('probe-cap-10'), reason: 'the 11th, must be rejected' },
    });
    expect(eleventh.statusCode).toBe(409);
    expect(eleventh.json()).toMatchObject({ error: 'hotfix_rule_cap_exceeded' });

    const listRes = await app.inject({ method: 'GET', url: '/hotfix-rules', cookies: { sentinel_session: cookie } });
    const listed = (listRes.json() as { hotfixRules: unknown[] }).hotfixRules;
    expect(listed).toHaveLength(10);
  });

  // T3: "Creation by a non-elevated role is denied and audited." Covers
  // both halves of "elevated" this route's own design actually checks.
  it('T3: denies a customer tenant admin (right rank, wrong tenant) and audits it', async () => {
    const cookie = await signIn(customerAdminEmail);
    const res = await app.inject({
      method: 'POST',
      url: '/hotfix-rules',
      cookies: { sentinel_session: cookie },
      payload: { ruleYaml: sampleRuleYaml('probe-denied-1'), reason: 'should never be created' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'insufficient_role' });

    const auditRows = await asAdmin(
      (c) => c.query(`SELECT action FROM audit_log WHERE action = 'hotfix_rule.create_denied' AND actor_id = $1`, [customerAdminUserId]),
      customerTenantId,
    );
    expect(auditRows.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('T3: denies an under-ranked member of the ops tenant itself and audits it', async () => {
    const cookie = await signIn(opsAnalystEmail);
    const res = await app.inject({
      method: 'POST',
      url: '/hotfix-rules',
      cookies: { sentinel_session: cookie },
      payload: { ruleYaml: sampleRuleYaml('probe-denied-2'), reason: 'should never be created' },
    });
    expect(res.statusCode).toBe(403);

    const auditRows = await asAdmin(
      (c) => c.query(`SELECT action FROM audit_log WHERE action = 'hotfix_rule.create_denied' AND actor_id = $1`, [opsAnalystUserId]),
      opsTenantId,
    );
    expect(auditRows.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects a request with no session', async () => {
    const res = await app.inject({ method: 'GET', url: '/hotfix-rules' });
    expect(res.statusCode).toBe(401);
  });
});
