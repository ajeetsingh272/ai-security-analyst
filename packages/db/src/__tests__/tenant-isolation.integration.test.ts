/**
 * P0-05 T1/T2 — real cross-tenant isolation, through the application layer.
 *
 * Deliberately connects with `createControlPlanePool()`'s default connection
 * string — the superuser-ish `sentinel` role from docker-compose, not a
 * hand-crafted `sentinel_app` connection. That default is what production
 * code actually gets if nobody overrides `POSTGRES_URL`, and a superuser
 * bypasses row-level security unconditionally. The only thing standing
 * between that default and a silent, total RLS bypass is the `SET LOCAL ROLE
 * sentinel_app` inside `TenantScopedRepository.withTransaction` — so this
 * test exercises that class, not raw SQL with the role switch already baked
 * into the test. `scripts/verify-setup.sh` already proves isolation holds at
 * the database layer; this proves the application layer actually reaches it.
 *
 * Covers every tenant-scoped table, including audit_log — tested inside a
 * transaction that is rolled back rather than committed, since audit_log
 * forbids DELETE for sentinel_app and a permanent throwaway row would be
 * exactly the kind of noise an append-only table exists to prevent.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate (db:seed not required — this
 * creates and tears down its own two tenants).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  createControlPlanePool,
  withTenantContext,
  TenantScopedRepository,
} from '../index.js';

/** Exposes the protected transaction helper generically, for fixtures and
 * assertions that span every tenant-scoped table rather than one repository's
 * own narrow query set. Production code should prefer a named repository
 * like CasesRepository; this exists only so the test can drive the SAME
 * mechanism — role switch plus SET LOCAL tenant_id — against every table. */
class GenericTenantRepository extends TenantScopedRepository {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(sql, params);
      return rows as T[];
    });
  }
}

let pool: Pool;
let tenantA: string;
let tenantB: string;
let sharedUserId: string;

async function asTenant<T>(tenantId: string, fn: (repo: GenericTenantRepository) => Promise<T>) {
  return withTenantContext(tenantId, () => fn(new GenericTenantRepository(pool)));
}

/** Raw admin access for fixture setup/teardown that must span both tenants at
 * once (creating the tenants themselves; deleting them afterward). Runs as
 * sentinel_app too, not as superuser, so even setup proves the role has the
 * grants it needs. */
async function asAdmin<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
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
         ('P0-05 isolation probe A', 'trial'),
         ('P0-05 isolation probe B', 'trial')
       RETURNING id`,
    ),
  );
  tenantA = tenants.rows[0].id;
  tenantB = tenants.rows[1].id;

  // Users are tenant-agnostic (not RLS-scoped); one throwaway user serves
  // both tenants' membership rows, matching how a real MSP analyst would.
  const users = await asAdmin((c) =>
    c.query(`INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id`, [
      'p0-05-probe@example.invalid',
      'P0-05 probe user',
    ]),
  );
  sharedUserId = users.rows[0].id;
});

afterAll(async () => {
  // Deleting the two tenants cascades through every FK that references
  // tenants(id) ON DELETE CASCADE — connectors, connector_cursors, cases,
  // case_transitions, actions, approval_nonces, memberships — in one
  // statement. audit_log has no such FK (by design: an audit entry must
  // outlive the tenant it describes), but no audit_log row is ever committed
  // by this suite, so there is nothing there to clean up.
  await asAdmin((c) =>
    c.query('DELETE FROM tenants WHERE id = ANY($1)', [[tenantA, tenantB]]),
  );
  await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [sharedUserId]));
  await pool.end();
});

describe('cross-tenant isolation through TenantScopedRepository', () => {
  it('memberships: a row created for tenant A is invisible to tenant B, even unfiltered', async () => {
    await asTenant(tenantA, (repo) =>
      repo.query(
        `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [tenantA, sharedUserId],
      ),
    );

    // T2: no WHERE tenant_id clause here at all — isolation comes entirely
    // from the RLS policy reached through the role switch, not from this query.
    const asA = await asTenant(tenantA, (repo) => repo.query('SELECT user_id FROM memberships'));
    const asB = await asTenant(tenantB, (repo) => repo.query('SELECT user_id FROM memberships'));

    expect(asA).toHaveLength(1);
    expect(asB).toHaveLength(0); // T1: zero rows, not an error, not the wrong tenant's row.
  });

  it('connectors and connector_cursors: composite-FK-linked rows stay within their tenant', async () => {
    const connA = await asTenant(tenantA, (repo) =>
      repo.query<{ id: string }>(
        `INSERT INTO connectors (tenant_id, kind) VALUES ($1, 'm365') RETURNING id`,
        [tenantA],
      ),
    );
    await asTenant(tenantA, (repo) =>
      repo.query(
        `INSERT INTO connector_cursors (connector_id, tenant_id, stream, cursor)
         VALUES ($1, $2, 'unified_audit', '{}')`,
        [connA[0]!.id, tenantA],
      ),
    );

    const cursorsAsA = await asTenant(tenantA, (repo) => repo.query('SELECT stream FROM connector_cursors'));
    const cursorsAsB = await asTenant(tenantB, (repo) => repo.query('SELECT stream FROM connector_cursors'));
    const connectorsAsB = await asTenant(tenantB, (repo) => repo.query('SELECT id FROM connectors'));

    expect(cursorsAsA).toHaveLength(1);
    expect(cursorsAsB).toHaveLength(0);
    expect(connectorsAsB).toHaveLength(0);
  });

  it('cases, case_transitions, actions, approval_nonces: the whole case chain stays within its tenant', async () => {
    const caseA = await asTenant(tenantA, (repo) =>
      repo.query<{ id: string }>(
        `INSERT INTO cases (tenant_id, title, window_start) VALUES ($1, 'probe case', now()) RETURNING id`,
        [tenantA],
      ),
    );
    const caseId = caseA[0]!.id;

    await asTenant(tenantA, (repo) =>
      repo.query(
        `INSERT INTO case_transitions (tenant_id, case_id, to_state, actor_type, actor_id, reason)
         VALUES ($1, $2, 'open', 'system', 'test', 'probe')`,
        [tenantA, caseId],
      ),
    );
    const actionA = await asTenant(tenantA, (repo) =>
      repo.query<{ id: string }>(
        `INSERT INTO actions (tenant_id, case_id, playbook, target, blast_radius)
         VALUES ($1, $2, 'probe_playbook', '{}', 'test') RETURNING id`,
        [tenantA, caseId],
      ),
    );
    await asTenant(tenantA, (repo) =>
      repo.query(
        `INSERT INTO approval_nonces (nonce, tenant_id, action_id) VALUES ($1, $2, $3)`,
        [`probe-nonce-${caseId}`, tenantA, actionA[0]!.id],
      ),
    );

    for (const [table, tenantCol] of [
      ['cases', 'id'],
      ['case_transitions', 'case_id'],
      ['actions', 'id'],
      ['approval_nonces', 'nonce'],
    ] as const) {
      const asA = await asTenant(tenantA, (repo) => repo.query(`SELECT ${tenantCol} FROM ${table}`));
      const asB = await asTenant(tenantB, (repo) => repo.query(`SELECT ${tenantCol} FROM ${table}`));
      expect(asA.length, `${table} as tenant A`).toBeGreaterThan(0);
      expect(asB.length, `${table} as tenant B must see none of tenant A's rows`).toBe(0);
    }
  });

  it('audit_log: cross-tenant isolation holds even though the table forbids DELETE', async () => {
    // Never committed: audit_log allows INSERT and SELECT for sentinel_app
    // but not UPDATE or DELETE (TG6), so a throwaway probe row is written and
    // read entirely inside one transaction that always rolls back — the real
    // table gains nothing permanent from this test having run.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE sentinel_app');
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantA]);
      await client.query(
        `INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, subject_type, subject_id, prev_hash, entry_hash)
         VALUES ($1, 'system', 'test', 'probe', 'test', 'probe', $2, $3)`,
        [tenantA, Buffer.alloc(32), Buffer.alloc(32, 1)],
      );

      const asA = await client.query("SELECT action FROM audit_log WHERE action = 'probe'");
      expect(asA.rows).toHaveLength(1);

      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantB]);
      const asB = await client.query("SELECT action FROM audit_log WHERE action = 'probe'");
      expect(asB.rows).toHaveLength(0); // T1/T2, even on the append-only table.
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});
