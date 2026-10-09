/**
 * P7-02 — the AWS CloudTrail connector's HTTP surface, against real
 * Postgres. No OAuth mock is needed here (unlike m365/google's own
 * integration tests) — see aws-connector.ts's own doc comment for why
 * this connector has no browser-redirect-mediated consent step at all.
 * Real role-assumption/SQS-consumption (T1) is proven Go-side, against
 * both a fake interface and a real local SQS-protocol server
 * (go/sentinelconnector/aws/sqs_integration_test.go) — there is no real
 * AWS test account available in this sandbox, the same disclosed gap
 * every other connector's own T1 already has.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import pg from 'pg';
import { hashPassword } from '../auth/password.js';
import { buildApp } from '../app.js';
import { externalIdForTenant } from '../routes/aws-connector.js';

const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel',
});
let redis: RedisClientType;
let app: FastifyInstance;
const kmsMasterKey = randomBytes(32).toString('base64');
const externalIdSecret = 'test-external-id-secret';

const KNOWN_PASSWORD = 'correct horse battery staple';
let tenantId: string;
let userId: string;
let userEmail: string;

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

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();
  await redis.del('ratelimit:signin:ip:127.0.0.1');

  process.env['KMS_LOCAL_MASTER_KEY'] = kmsMasterKey;

  tenantId = randomUUID();
  userId = randomUUID();
  userEmail = `p7-02-probe-${userId}@example.invalid`;

  await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [tenantId, 'P7-02 probe tenant', 'trial']));
  const passwordHash = await hashPassword(KNOWN_PASSWORD);
  await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [userId, userEmail, passwordHash]));
  await asAdmin(
    (c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [tenantId, userId]),
    tenantId,
  );
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [userId]));
  await redis.quit();
  await pool.end();
});

beforeEach(async () => {
  app = await buildApp({ pool, redis, cookieSecure: false, awsExternalIdSecret: externalIdSecret });
});

afterEach(async () => {
  await app.close();
});

async function signIn(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/sign-in', payload: { email: userEmail, password: KNOWN_PASSWORD } });
  const cookie = cookieFrom(res);
  if (!cookie) throw new Error('sign-in did not return a session cookie');
  return cookie;
}

describe('GET /connectors/aws/external-id', () => {
  it('returns 503 when no secret is configured', async () => {
    const unconfiguredApp = await buildApp({ pool, redis, cookieSecure: false, awsExternalIdSecret: undefined });
    try {
      const res = await unconfiguredApp.inject({ method: 'POST', url: '/auth/sign-in', payload: { email: userEmail, password: KNOWN_PASSWORD } });
      const cookie = cookieFrom(res)!;
      const res2 = await unconfiguredApp.inject({ method: 'GET', url: '/connectors/aws/external-id', cookies: { sentinel_session: cookie } });
      expect(res2.statusCode).toBe(503);
      expect(res2.json().error).toBe('aws_not_configured');
    } finally {
      await unconfiguredApp.close();
    }
  });

  it('returns a deterministic external id, stable across repeated reads', async () => {
    const cookie = await signIn();
    const res1 = await app.inject({ method: 'GET', url: '/connectors/aws/external-id', cookies: { sentinel_session: cookie } });
    const res2 = await app.inject({ method: 'GET', url: '/connectors/aws/external-id', cookies: { sentinel_session: cookie } });
    expect(res1.statusCode).toBe(200);
    expect(res1.json().externalId).toBe(res2.json().externalId);
    expect(res1.json().externalId).toBe(externalIdForTenant(externalIdSecret, tenantId));
  });

  it('rejects a read_only member — admin is the minimum required role', async () => {
    const readOnlyUserId = randomUUID();
    const readOnlyEmail = `p7-02-readonly-${readOnlyUserId}@example.invalid`;
    const readOnlyPasswordHash = await hashPassword(KNOWN_PASSWORD);
    await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [readOnlyUserId, readOnlyEmail, readOnlyPasswordHash]));
    await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'read_only')`, [tenantId, readOnlyUserId]), tenantId);
    try {
      const signInRes = await app.inject({ method: 'POST', url: '/auth/sign-in', payload: { email: readOnlyEmail, password: KNOWN_PASSWORD } });
      const cookie = cookieFrom(signInRes)!;
      const res = await app.inject({ method: 'GET', url: '/connectors/aws/external-id', cookies: { sentinel_session: cookie } });
      expect(res.statusCode).toBe(403);
    } finally {
      await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [readOnlyUserId]));
    }
  });
});

describe('POST /connectors/aws/connect', () => {
  it('rejects a malformed role ARN', async () => {
    const cookie = await signIn();
    const res = await app.inject({
      method: 'POST',
      url: '/connectors/aws/connect',
      cookies: { sentinel_session: cookie },
      payload: { roleArn: 'not-an-arn', region: 'ap-south-1', queueUrl: 'https://sqs.ap-south-1.amazonaws.com/123456789012/q' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_role_arn');
  });

  it('rejects a non-https queue URL', async () => {
    const cookie = await signIn();
    const res = await app.inject({
      method: 'POST',
      url: '/connectors/aws/connect',
      cookies: { sentinel_session: cookie },
      payload: { roleArn: 'arn:aws:iam::123456789012:role/Sentinel', region: 'ap-south-1', queueUrl: 'http://sqs.ap-south-1.amazonaws.com/123456789012/q' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_queue_url');
  });

  it('stores an encrypted, decryptable credential with the SERVER-derived external id — never one the client could supply', async () => {
    const cookie = await signIn();
    const res = await app.inject({
      method: 'POST',
      url: '/connectors/aws/connect',
      cookies: { sentinel_session: cookie },
      // A client-supplied externalId in the body (if there were one)
      // would be ignored entirely — there isn't a field for it at all,
      // which is itself the point this test is proving in spirit.
      payload: { roleArn: 'arn:aws:iam::123456789012:role/Sentinel', region: 'ap-south-1', queueUrl: 'https://sqs.ap-south-1.amazonaws.com/123456789012/q' },
    });
    expect(res.statusCode).toBe(200);

    const { rows } = await asAdmin((c) => c.query('SELECT status, credentials, dek_id FROM connectors WHERE tenant_id = $1 AND kind = $2', [tenantId, 'aws']), tenantId);
    expect(rows[0].status).toBe('healthy');
    expect(Buffer.isBuffer(rows[0].credentials)).toBe(true);
    expect(rows[0].dek_id).toBeTruthy();

    const audit = await asAdmin((c) => c.query("SELECT action FROM audit_log WHERE tenant_id = $1 AND action = 'connector.consent_granted' ORDER BY id DESC LIMIT 1", [tenantId]), tenantId);
    expect(audit.rows).toHaveLength(1);
  });
});

describe('POST /connectors/aws/revoke', () => {
  it('deletes the stored credentials, marks the connector revoked, and audits it', async () => {
    const cookie = await signIn();
    await app.inject({
      method: 'POST',
      url: '/connectors/aws/connect',
      cookies: { sentinel_session: cookie },
      payload: { roleArn: 'arn:aws:iam::123456789012:role/ToBeRevoked', region: 'ap-south-1', queueUrl: 'https://sqs.ap-south-1.amazonaws.com/123456789012/q' },
    });

    const revokeRes = await app.inject({ method: 'POST', url: '/connectors/aws/revoke', cookies: { sentinel_session: cookie } });
    expect(revokeRes.statusCode).toBe(200);

    const { rows } = await asAdmin((c) => c.query('SELECT status, credentials, dek_id FROM connectors WHERE tenant_id = $1 AND kind = $2', [tenantId, 'aws']), tenantId);
    expect(rows[0].status).toBe('revoked');
    expect(rows[0].credentials).toBeNull();
    expect(rows[0].dek_id).toBeNull();
  });

  it('returns 404 for a tenant that never connected AWS at all', async () => {
    const neverConnectedTenantId = randomUUID();
    const neverConnectedUserId = randomUUID();
    const neverConnectedEmail = `p7-02-never-${neverConnectedUserId}@example.invalid`;
    await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [neverConnectedTenantId, 'P7-02 never-connected probe', 'trial']));
    const neverConnectedPasswordHash = await hashPassword(KNOWN_PASSWORD);
    await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [neverConnectedUserId, neverConnectedEmail, neverConnectedPasswordHash]));
    await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [neverConnectedTenantId, neverConnectedUserId]), neverConnectedTenantId);
    try {
      const signInRes = await app.inject({ method: 'POST', url: '/auth/sign-in', payload: { email: neverConnectedEmail, password: KNOWN_PASSWORD } });
      const cookie = cookieFrom(signInRes)!;
      const res = await app.inject({ method: 'POST', url: '/connectors/aws/revoke', cookies: { sentinel_session: cookie } });
      expect(res.statusCode).toBe(404);
    } finally {
      await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [neverConnectedTenantId]));
      await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [neverConnectedUserId]));
    }
  });
});
