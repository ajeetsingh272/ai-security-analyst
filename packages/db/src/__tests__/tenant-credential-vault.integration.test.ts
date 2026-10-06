/**
 * P1-02 T2 (database-backed half) — TenantCredentialVault against the real
 * Postgres: the per-tenant DEK is actually persisted in tenant_deks and
 * reused rather than regenerated, concurrent "first use" by two requests
 * for the same tenant converges on one DEK rather than a race, and a vault
 * holding the wrong KMS master key cannot decrypt a real stored row. The
 * pure crypto (envelope.ts/kms.ts) is tested without a database at all in
 * envelope-crypto.test.ts; this is only the part that needs Postgres.
 *
 * Row counts are read through `withTenantContext` + TenantScopedRepository
 * (via GenericTenantRepository below), not through the raw admin bypass
 * `asAdmin` uses for fixture setup — found out why the hard way: asAdmin's
 * connection never sets `app.tenant_id` at all, and a pooled connection
 * that a PRIOR tenant-scoped transaction already touched leaves that
 * custom GUC at `''` (empty string) once its own transaction commits, not
 * NULL — a genuine, surprising Postgres behavior (confirmed directly
 * against the server, independent of this codebase or vitest): the FIRST
 * time a custom GUC is set LOCAL on a connection, its placeholder is
 * created for the rest of the session; committing the transaction that
 * set it reverts its VALUE, but to the empty string, not back to
 * "undeclared". tenant_deks has FORCE ROW LEVEL SECURITY, so its policy
 * expression (`tenant_id = current_setting('app.tenant_id', true)::uuid`)
 * then tries to cast that leftover '' to uuid and fails outright — where
 * a table with no RLS at all, or a connection that never had the GUC set
 * before, would see plain NULL and just match zero rows, no error. Not a
 * bug in TenantCredentialVault or the RLS mechanism itself (every
 * PRODUCTION call always sets app.tenant_id itself before querying,
 * so this empty-placeholder window is never actually observed by real
 * code) — purely a property of reusing asAdmin's raw-bypass pattern
 * against a FORCE-RLS table specifically, which the existing reference
 * (tenant-isolation.integration.test.ts) never happens to do.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import {
  createControlPlanePool,
  withTenantContext,
  TenantScopedRepository,
  LocalKMS,
  TenantCredentialVault,
} from '../index.js';

/** Same role as tenant-isolation.integration.test.ts's own
 * GenericTenantRepository — an ad hoc, RLS-respecting query for
 * assertions that don't warrant a named production repository. */
class GenericTenantRepository extends TenantScopedRepository {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return this.withTransaction(async (client: PoolClient) => {
      const { rows } = await client.query(sql, params);
      return rows as T[];
    });
  }
}

async function countTenantDeks(pool: Pool, tenantId: string): Promise<number> {
  const rows = await withTenantContext(tenantId, () =>
    new GenericTenantRepository(pool).query<{ n: number }>(
      'SELECT count(*)::int AS n FROM tenant_deks WHERE tenant_id = $1',
      [tenantId],
    ),
  );
  return rows[0]!.n;
}

let pool: Pool;
let tenantA: string;
let tenantB: string;
const masterKey = randomBytes(32).toString('base64');

async function asAdmin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE sentinel_app');
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
  pool = createControlPlanePool();
  const tenants = await asAdmin((c) =>
    c.query(
      `INSERT INTO tenants (name, plan) VALUES
         ('P1-02 vault probe A', 'trial'),
         ('P1-02 vault probe B', 'trial')
       RETURNING id`,
    ),
  );
  tenantA = tenants.rows[0].id;
  tenantB = tenants.rows[1].id;
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = ANY($1)', [[tenantA, tenantB]]));
  await pool.end();
});

describe('TenantCredentialVault', () => {
  it('round-trips credentials through separate encrypt/decrypt calls and separate vault instances', async () => {
    const kms = new LocalKMS(masterKey);
    const credentials = { refreshToken: 'a-real-looking-refresh-token', scope: 'ActivityFeed.Read' };

    const encrypted = await withTenantContext(tenantA, () =>
      new TenantCredentialVault(pool, kms).encryptCredentials(credentials),
    );

    // A brand-new vault instance, same tenant — proves the DEK was
    // actually persisted to tenant_deks and re-derived, not just held in
    // the first instance's own memory.
    const decrypted = await withTenantContext(tenantA, () =>
      new TenantCredentialVault(pool, kms).decryptCredentials(encrypted.encrypted),
    );

    expect(decrypted).toEqual(credentials);
  });

  it('creates exactly one tenant_deks row per tenant, reused across multiple encryptions', async () => {
    const kms = new LocalKMS(masterKey);
    await withTenantContext(tenantB, async () => {
      const vault = new TenantCredentialVault(pool, kms);
      await vault.encryptCredentials({ n: 1 });
      await vault.encryptCredentials({ n: 2 });
      await vault.encryptCredentials({ n: 3 });
    });

    expect(await countTenantDeks(pool, tenantB)).toBe(1);
  });

  it('isolates tenants: tenant A cannot decrypt tenant B\'s credentials (different DEKs)', async () => {
    const kms = new LocalKMS(masterKey);
    const encryptedForB = await withTenantContext(tenantB, () =>
      new TenantCredentialVault(pool, kms).encryptCredentials({ secret: 'belongs-to-tenant-b' }),
    );

    await expect(
      withTenantContext(tenantA, () => new TenantCredentialVault(pool, kms).decryptCredentials(encryptedForB.encrypted)),
    ).rejects.toThrow();
  });

  it('converges on one DEK when two requests race to be "first" for a brand-new tenant', async () => {
    const kms = new LocalKMS(masterKey);
    const freshTenant = await asAdmin((c) =>
      c.query(`INSERT INTO tenants (name, plan) VALUES ('P1-02 vault race probe', 'trial') RETURNING id`),
    );
    const tenantId = freshTenant.rows[0].id;
    try {
      const [encA, encB] = await withTenantContext(tenantId, () =>
        Promise.all([
          new TenantCredentialVault(pool, kms).encryptCredentials({ who: 'first' }),
          new TenantCredentialVault(pool, kms).encryptCredentials({ who: 'second' }),
        ]),
      );

      // Exactly one row, regardless of which request's INSERT actually won.
      expect(await countTenantDeks(pool, tenantId)).toBe(1);

      // Both results must be decryptable by a THIRD, freshly-constructed
      // vault — proof both calls ended up using the one DEK that was
      // actually stored, not two different in-memory DEKs that only one
      // of them persisted.
      const [decA, decB] = await withTenantContext(tenantId, () =>
        Promise.all([
          new TenantCredentialVault(pool, kms).decryptCredentials(encA.encrypted),
          new TenantCredentialVault(pool, kms).decryptCredentials(encB.encrypted),
        ]),
      );
      expect(decA).toEqual({ who: 'first' });
      expect(decB).toEqual({ who: 'second' });
    } finally {
      await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
    }
  });

  it('T2, end to end: a vault holding the WRONG KMS master key cannot decrypt a real stored row', async () => {
    const realKms = new LocalKMS(masterKey);
    const encrypted = await withTenantContext(tenantA, () =>
      new TenantCredentialVault(pool, realKms).encryptCredentials({ refreshToken: 'only-the-real-key-can-read-this' }),
    );

    const attackerKms = new LocalKMS(randomBytes(32).toString('base64'));
    await expect(
      withTenantContext(tenantA, () => new TenantCredentialVault(pool, attackerKms).decryptCredentials(encrypted.encrypted)),
    ).rejects.toThrow();
  });
});
