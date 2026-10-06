/**
 * P0-09 T2, T3, T4 — against the real Postgres and Redis the dev stack
 * provides. T1 (every role denied outside its permission set) is covered
 * exhaustively, without a database, in rbac.test.ts; mixing it in here would
 * make 16 role-pair assertions depend on infrastructure they don't need.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import pg from 'pg';
import { hashPassword } from '../auth/password.js';
import { authPlugin } from '../auth/auth-plugin.js';
import { tenantContextPlugin } from '../plugins/tenant-context.js';
import { canActAsTenant } from '../auth/msp-access.js';
import { withTenantContext } from '@sentinel/db';

const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel',
});
let redis: RedisClientType;
let app: FastifyInstance;

const KNOWN_PASSWORD = 'correct horse battery staple';
let tenantId: string;
let userId: string;
let userEmail: string;

/**
 * Inserts fixture rows as sentinel_app. `tenantId` is optional and only
 * needed for a tenant-scoped table (memberships, cases, ...) — omitting it
 * is for genuinely global tables (tenants, users), which have no RLS policy
 * to satisfy at all. The first version of this helper always omitted it,
 * which worked for tenants/users and then failed with "new row violates
 * row-level security policy" the moment it was reused for a memberships
 * insert — that table's policy needs app.tenant_id set to match the row
 * being written, same as every other tenant-scoped table.
 */
async function asAdmin<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  tenantId?: string,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE sentinel_app');
    if (tenantId) {
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
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

beforeAll(async () => {
  redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
  await redis.connect();

  // fastify.inject() always reports the same synthetic IP (127.0.0.1), and
  // the IP-based rate-limit key is NOT randomised the way every account
  // email in this file is — so repeated LOCAL runs of this suite against
  // the same persistent Redis accumulate toward IP_LIMIT across invocations
  // that have nothing to do with each other. Found by running this suite
  // five times in a row while debugging an unrelated ordering bug: the
  // sixth run failed with "No active session" on a CORRECT password, and
  // `GET ratelimit:signin:ip:127.0.0.1` read back 21 — one over the limit —
  // entirely from this file's own prior runs. CI starts from a fresh Redis
  // every time and would never see this; a long-lived local dev stack does.
  await redis.del('ratelimit:signin:ip:127.0.0.1');

  tenantId = randomUUID();
  userId = randomUUID();
  userEmail = `p0-09-probe-${userId}@example.invalid`;

  await asAdmin((c) =>
    c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)', [
      tenantId,
      'P0-09 probe tenant',
      'trial',
    ]),
  );
  const passwordHash = await hashPassword(KNOWN_PASSWORD);
  await asAdmin((c) =>
    c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [
      userId,
      userEmail,
      passwordHash,
    ]),
  );
  await asAdmin(
    (c) =>
      c.query(
        `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [tenantId, userId],
      ),
    tenantId,
  );

  app = Fastify();
  // Order matters and is not obvious: authPlugin's onRequest hook populates
  // request.session from the cookie; tenantContextPlugin's onRequest hook
  // reads it and rejects if absent. Both are registered top-level (fp()),
  // so Fastify runs their hooks in REGISTRATION order — registering
  // tenantContextPlugin first (as this test originally did) means its
  // check runs before auth has had a chance to populate anything, and every
  // request looks unauthenticated even with a valid session cookie attached.
  await app.register(authPlugin, { pool, redis, cookieSecure: false });
  await app.register(tenantContextPlugin, { publicPaths: ['/auth/sign-in', '/auth/sign-out'] });
  app.get('/whoami', async (request) => ({ tenantId: request.session?.tenantId }));
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [userId]));
  // Leave the shared IP counter clean for whatever runs next, same reason
  // it was cleared in beforeAll.
  await redis.del('ratelimit:signin:ip:127.0.0.1');
  await redis.quit();
  await pool.end();
  await app.close();
});

function cookieFrom(res: { cookies: Array<{ name: string; value: string }> }): string | undefined {
  return res.cookies.find((c) => c.name === 'sentinel_session')?.value;
}

describe('sign-in flow against the real database', () => {
  it('a correct password signs in and the cookie authenticates a later request', async () => {
    const signIn = await app.inject({
      method: 'POST',
      url: '/auth/sign-in',
      payload: { email: userEmail, password: KNOWN_PASSWORD },
    });
    expect(signIn.statusCode).toBe(200);
    const sessionCookie = cookieFrom(signIn);
    expect(sessionCookie).toBeTruthy();

    const who = await app.inject({
      method: 'GET',
      url: '/whoami',
      cookies: { sentinel_session: sessionCookie! },
    });
    expect(who.json()).toEqual({ tenantId });
  });

  it('a wrong password is rejected and does not set a cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/sign-in',
      payload: { email: userEmail, password: 'wrong password entirely' },
    });
    expect(res.statusCode).toBe(401);
    expect(cookieFrom(res)).toBeUndefined();
  });

  it('T3: revoking a session takes effect immediately on the very next request', async () => {
    const signIn = await app.inject({
      method: 'POST',
      url: '/auth/sign-in',
      payload: { email: userEmail, password: KNOWN_PASSWORD },
    });
    const sessionCookie = cookieFrom(signIn)!;

    const before = await app.inject({
      method: 'GET',
      url: '/whoami',
      cookies: { sentinel_session: sessionCookie },
    });
    expect(before.json()).toEqual({ tenantId });

    await app.inject({
      method: 'POST',
      url: '/auth/sign-out',
      cookies: { sentinel_session: sessionCookie },
    });

    // Same cookie, same browser-equivalent state — the ONLY thing that
    // changed is server-side revocation. If this still worked, revocation
    // would be decorative.
    const after = await app.inject({
      method: 'GET',
      url: '/whoami',
      cookies: { sentinel_session: sessionCookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it('T4: repeated failed attempts are rate limited, and the failures are audited', async () => {
    const bruteForceEmail = `p0-09-bruteforce-${randomUUID()}@example.invalid`;
    const bfUserId = randomUUID();
    const bfPasswordHash = await hashPassword('the real password');
    await asAdmin((c) =>
      c.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [
        bfUserId,
        bruteForceEmail,
        bfPasswordHash,
      ]),
    );
    await asAdmin(
      (c) =>
        c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`, [
          tenantId,
          bfUserId,
        ]),
      tenantId,
    );

    let lastStatus = 0;
    for (let i = 0; i < 7; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/sign-in',
        payload: { email: bruteForceEmail, password: `wrong-${i}` },
      });
      lastStatus = res.statusCode;
    }
    // ACCOUNT_LIMIT.maxAttempts is 5 — the 6th and 7th attempts must be
    // blocked by the limiter, not merely fail on bad credentials.
    expect(lastStatus).toBe(429);

    // Audited: at least one sign_in_failed entry exists for this tenant
    // (written because the user DOES exist, even though every attempt used
    // the wrong password).
    const auditRows = await withTenantContext(tenantId, async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE sentinel_app');
        await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
        const { rows } = await client.query(
          `SELECT action FROM audit_log WHERE actor_id = $1 AND action = 'auth.sign_in_failed'`,
          [bfUserId],
        );
        await client.query('COMMIT');
        return rows;
      } finally {
        client.release();
      }
    });
    expect(auditRows.length).toBeGreaterThan(0);

    await asAdmin((c) => c.query('DELETE FROM memberships WHERE user_id = $1', [bfUserId]), tenantId);
    await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [bfUserId]));
  });
});

describe('T2: MSP cross-tenant access', () => {
  it('an MSP user cannot act on a client tenant they are not linked to', async () => {
    const mspTenant = randomUUID();
    const unrelatedClientTenant = randomUUID();

    await asAdmin((c) =>
      c.query('INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3), ($4, $5, $6)', [
        mspTenant,
        'P0-09 MSP probe',
        'msp',
        unrelatedClientTenant,
        'P0-09 unrelated client probe',
        'trial',
      ]),
    );

    const allowed = await withTenantContext(mspTenant, () =>
      canActAsTenant(pool, mspTenant, unrelatedClientTenant),
    );
    expect(allowed).toBe(false);

    // Now create the link, and the same check must flip to true — proving
    // the denial above was because no link existed, not because the
    // function always returns false.
    await asAdmin(
      (c) =>
        c.query(
          'INSERT INTO msp_links (msp_tenant_id, client_tenant_id) VALUES ($1, $2)',
          [mspTenant, unrelatedClientTenant],
        ),
      mspTenant,
    );
    const allowedAfterLink = await withTenantContext(mspTenant, () =>
      canActAsTenant(pool, mspTenant, unrelatedClientTenant),
    );
    expect(allowedAfterLink).toBe(true);

    // And the reverse direction must stay false — a client does not get
    // MSP-style reach into the MSP that manages it.
    const reverseDenied = await withTenantContext(unrelatedClientTenant, () =>
      canActAsTenant(pool, unrelatedClientTenant, mspTenant),
    );
    expect(reverseDenied).toBe(false);

    await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = ANY($1)', [[mspTenant, unrelatedClientTenant]]));
  });

  it('acting on ones own tenant never needs a link', async () => {
    const allowed = await withTenantContext(tenantId, () => canActAsTenant(pool, tenantId, tenantId));
    expect(allowed).toBe(true);
  });
});
