/**
 * P7-03 — the Azure/Entra ID connector's HTTP surface, against real
 * Postgres. No OAuth mock is needed — see azure-connector.ts's own doc
 * comment for why. Real Event Hub consumption (T1) is proven Go-side,
 * against both a fake interface and the real Event Hubs emulator
 * (go/sentinelconnector/azure/eventhub_integration_test.go).
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

const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel',
});
let redis: RedisClientType;
let app: FastifyInstance;
const kmsMasterKey = randomBytes(32).toString('base64');

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
  userEmail = `p7-03-probe-${userId}@example.invalid`;

  await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [tenantId, 'P7-03 probe tenant', 'trial']));
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
  app = await buildApp({ pool, redis, cookieSecure: false });
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

const VALID_CONNECTION_STRING = 'Endpoint=sb://sentinel-test.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=abc123=';

describe('POST /connectors/azure/connect', () => {
  it('rejects a connection string missing the Endpoint prefix', async () => {
    const cookie = await signIn();
    const res = await app.inject({
      method: 'POST',
      url: '/connectors/azure/connect',
      cookies: { sentinel_session: cookie },
      payload: { connectionString: 'not-a-connection-string', eventHubName: 'entra-diagnostics' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_connection_string');
  });

  it('rejects a missing eventHubName', async () => {
    const cookie = await signIn();
    const res = await app.inject({
      method: 'POST',
      url: '/connectors/azure/connect',
      cookies: { sentinel_session: cookie },
      payload: { connectionString: VALID_CONNECTION_STRING },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_event_hub_name');
  });

  it('rejects a read_only member — admin is the minimum required role', async () => {
    const readOnlyUserId = randomUUID();
    const readOnlyEmail = `p7-03-readonly-${readOnlyUserId}@example.invalid`;
    const readOnlyPasswordHash = await hashPassword(KNOWN_PASSWORD);
    await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [readOnlyUserId, readOnlyEmail, readOnlyPasswordHash]));
    await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'read_only')`, [tenantId, readOnlyUserId]), tenantId);
    try {
      const signInRes = await app.inject({ method: 'POST', url: '/auth/sign-in', payload: { email: readOnlyEmail, password: KNOWN_PASSWORD } });
      const cookie = cookieFrom(signInRes)!;
      const res = await app.inject({
        method: 'POST',
        url: '/connectors/azure/connect',
        cookies: { sentinel_session: cookie },
        payload: { connectionString: VALID_CONNECTION_STRING, eventHubName: 'entra-diagnostics' },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [readOnlyUserId]));
    }
  });

  it('stores an encrypted, decryptable credential', async () => {
    const cookie = await signIn();
    const res = await app.inject({
      method: 'POST',
      url: '/connectors/azure/connect',
      cookies: { sentinel_session: cookie },
      payload: { connectionString: VALID_CONNECTION_STRING, eventHubName: 'entra-diagnostics' },
    });
    expect(res.statusCode).toBe(200);

    const { rows } = await asAdmin((c) => c.query('SELECT status, credentials, dek_id FROM connectors WHERE tenant_id = $1 AND kind = $2', [tenantId, 'azure']), tenantId);
    expect(rows[0].status).toBe('healthy');
    expect(Buffer.isBuffer(rows[0].credentials)).toBe(true);
    expect(rows[0].dek_id).toBeTruthy();

    const audit = await asAdmin((c) => c.query("SELECT action FROM audit_log WHERE tenant_id = $1 AND action = 'connector.consent_granted' ORDER BY id DESC LIMIT 1", [tenantId]), tenantId);
    expect(audit.rows).toHaveLength(1);
  });
});

describe('POST /connectors/azure/revoke', () => {
  it('deletes the stored credentials, marks the connector revoked, and audits it', async () => {
    const cookie = await signIn();
    await app.inject({
      method: 'POST',
      url: '/connectors/azure/connect',
      cookies: { sentinel_session: cookie },
      payload: { connectionString: VALID_CONNECTION_STRING, eventHubName: 'to-be-revoked' },
    });

    const revokeRes = await app.inject({ method: 'POST', url: '/connectors/azure/revoke', cookies: { sentinel_session: cookie } });
    expect(revokeRes.statusCode).toBe(200);

    const { rows } = await asAdmin((c) => c.query('SELECT status, credentials, dek_id FROM connectors WHERE tenant_id = $1 AND kind = $2', [tenantId, 'azure']), tenantId);
    expect(rows[0].status).toBe('revoked');
    expect(rows[0].credentials).toBeNull();
    expect(rows[0].dek_id).toBeNull();
  });

  it('returns 404 for a tenant that never connected Azure at all', async () => {
    const neverConnectedTenantId = randomUUID();
    const neverConnectedUserId = randomUUID();
    const neverConnectedEmail = `p7-03-never-${neverConnectedUserId}@example.invalid`;
    await asAdmin((c) => c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [neverConnectedTenantId, 'P7-03 never-connected probe', 'trial']));
    const neverConnectedPasswordHash = await hashPassword(KNOWN_PASSWORD);
    await asAdmin((c) => c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [neverConnectedUserId, neverConnectedEmail, neverConnectedPasswordHash]));
    await asAdmin((c) => c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [neverConnectedTenantId, neverConnectedUserId]), neverConnectedTenantId);
    try {
      const signInRes = await app.inject({ method: 'POST', url: '/auth/sign-in', payload: { email: neverConnectedEmail, password: KNOWN_PASSWORD } });
      const cookie = cookieFrom(signInRes)!;
      const res = await app.inject({ method: 'POST', url: '/connectors/azure/revoke', cookies: { sentinel_session: cookie } });
      expect(res.statusCode).toBe(404);
    } finally {
      await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [neverConnectedTenantId]));
      await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [neverConnectedUserId]));
    }
  });
});
