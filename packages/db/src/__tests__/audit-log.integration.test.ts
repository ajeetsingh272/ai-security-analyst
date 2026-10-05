/**
 * P0-06 T4, plus proof that AuditLogWriter's real hashes — not the unit
 * tests' synthetic ones — form a chain the real verifier accepts.
 *
 * A genuine consequence of testing an append-only table for real: the rows
 * this test writes through AuditLogWriter are committed by
 * TenantScopedRepository.withTransaction (BEGIN...COMMIT, not a transaction
 * this test controls), and audit_log forbids DELETE for sentinel_app —
 * there is no cleanup step because there is no way to write one. That is not
 * a test inconvenience; it is the property under test. Rows are tagged with
 * a distinctive actorId so they are identifiable later if ever needed, and
 * kept to a handful per run.
 *
 * No real `tenants` row is created: unlike every other tenant-scoped table,
 * audit_log has no foreign key back to tenants (by design — an audit entry
 * must outlive the tenant it describes), so a fresh random UUID is a valid
 * tenant_id here without needing a matching row to exist anywhere else.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createControlPlanePool,
  withTenantContext,
  AuditLogWriter,
  verifyChain,
  type AuditEntryRow,
} from '../index.js';

const pool = createControlPlanePool();
const PROBE_ACTOR_ID = 'p0-06-integration-test-probe';

describe('AuditLogWriter against a real database', () => {
  it('writes a chain of real entries that the real verifier accepts', async () => {
    const tenantId = randomUUID();

    const written = await withTenantContext(tenantId, async () => {
      const writer = new AuditLogWriter(pool);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const entry = await writer.insert({
          actorType: 'system',
          actorId: PROBE_ACTOR_ID,
          action: `probe.step-${i}`,
          subjectType: 'test',
          subjectId: tenantId,
          payload: { i },
        });
        ids.push(entry.id);
      }
      return ids;
    });

    expect(written).toHaveLength(5);

    // Read back as the application role would — through the same
    // tenant-scoped, role-switched path, not a superuser shortcut — and feed
    // the REAL rows (not synthetic ones) to the REAL verifier.
    const rows = await withTenantContext(tenantId, async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE sentinel_app');
        await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
        const { rows } = await client.query(
          `SELECT id, tenant_id, occurred_at, actor_type, actor_id, action,
                  subject_type, subject_id, payload, prev_hash, entry_hash
             FROM audit_log WHERE tenant_id = $1 ORDER BY id`,
          [tenantId],
        );
        await client.query('COMMIT');
        return rows;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    });

    expect(rows).toHaveLength(5);

    const chain: AuditEntryRow[] = rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      occurredAt: new Date(r.occurred_at).toISOString(),
      actorType: r.actor_type,
      actorId: r.actor_id,
      action: r.action,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      payload: r.payload,
      prevHash: r.prev_hash,
      entryHash: r.entry_hash,
    }));

    expect(verifyChain(chain)).toEqual({ ok: true });
  });

  it('two concurrent writers for the same tenant do not fork the chain', async () => {
    const tenantId = randomUUID();

    // Both start "at once" — the FOR UPDATE lock inside insert() must
    // serialise them rather than letting both read the same prevHash.
    const [a, b] = await withTenantContext(tenantId, async () => {
      const writer = new AuditLogWriter(pool);
      return Promise.all([
        writer.insert({
          actorType: 'system',
          actorId: PROBE_ACTOR_ID,
          action: 'probe.concurrent-a',
          subjectType: 'test',
          subjectId: tenantId,
        }),
        writer.insert({
          actorType: 'system',
          actorId: PROBE_ACTOR_ID,
          action: 'probe.concurrent-b',
          subjectType: 'test',
          subjectId: tenantId,
        }),
      ]);
    });

    // Different content, so different hashes regardless of locking — the
    // real assertion, that they form one chain rather than two forked
    // branches sharing GENESIS_HASH as a parent, is re-fetched and checked
    // against verifyChain below.
    expect(a.entryHash.equals(b.entryHash)).toBe(false);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE sentinel_app');
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
      const { rows } = await client.query(
        `SELECT id, tenant_id, occurred_at, actor_type, actor_id, action,
                subject_type, subject_id, payload, prev_hash, entry_hash
           FROM audit_log WHERE tenant_id = $1 ORDER BY id`,
        [tenantId],
      );
      await client.query('COMMIT');

      const chain: AuditEntryRow[] = rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        occurredAt: new Date(r.occurred_at).toISOString(),
        actorType: r.actor_type,
        actorId: r.actor_id,
        action: r.action,
        subjectType: r.subject_type,
        subjectId: r.subject_id,
        payload: r.payload,
        prevHash: r.prev_hash,
        entryHash: r.entry_hash,
      }));
      expect(chain).toHaveLength(2);
      // A valid chain of exactly 2 means one genuinely followed the other —
      // a fork (both claiming GENESIS_HASH as prevHash) would fail this.
      expect(verifyChain(chain)).toEqual({ ok: true });
    } finally {
      client.release();
    }
  });

  it('T4: UPDATE on a real row is rejected by Postgres grants, not just by convention', async () => {
    const tenantId = randomUUID();
    const entry = await withTenantContext(tenantId, () =>
      new AuditLogWriter(pool).insert({
        actorType: 'system',
        actorId: PROBE_ACTOR_ID,
        action: 'probe.update-rejection-target',
        subjectType: 'test',
        subjectId: tenantId,
      }),
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE sentinel_app');
      // The RLS policy's USING expression casts current_setting('app.tenant_id')
      // to uuid regardless of what statement triggered it — an UPDATE this
      // table should reject on GRANTS alone still evaluates that cast as part
      // of checking row visibility, and an unset tenant context makes it
      // fail on the cast itself ("invalid input syntax for type uuid") rather
      // than the permission-denied error this test is actually about. Setting
      // it is also the more realistic shape: a real caller always has one.
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
      await expect(
        client.query('UPDATE audit_log SET action = $1 WHERE id = $2', ['tampered', entry.id]),
      ).rejects.toThrow(/permission denied|append-only/i);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('DELETE on a real row is rejected too (AC2)', async () => {
    const tenantId = randomUUID();
    const entry = await withTenantContext(tenantId, () =>
      new AuditLogWriter(pool).insert({
        actorType: 'system',
        actorId: PROBE_ACTOR_ID,
        action: 'probe.delete-rejection-target',
        subjectType: 'test',
        subjectId: tenantId,
      }),
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE sentinel_app');
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
      await expect(
        client.query('DELETE FROM audit_log WHERE id = $1', [entry.id]),
      ).rejects.toThrow(/permission denied|append-only/i);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});
