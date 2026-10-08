/**
 * P5-06 — against real Postgres: the application-level guard
 * (PreApprovalRepository.grant throwing for a destructive playbook)
 * AND the migration's own DB-level CHECK constraint backstop, proven
 * independently rather than assuming the SQL text does what its
 * comment claims.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createControlPlanePool, withTenantContext, PreApprovalRepository, DestructivePlaybookCannotBePreApprovedError } from '../index.js';

let pool: Pool;
let tenantId: string;
let userId: string;

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

beforeAll(async () => {
  pool = createControlPlanePool();
  const tenantResult = await asAdmin((c) => c.query<{ id: string }>(`INSERT INTO tenants (name, plan) VALUES ('P5-06 pre-approval probe', 'trial') RETURNING id`));
  tenantId = tenantResult.rows[0]!.id;
  const userResult = await asAdmin((c) => c.query<{ id: string }>(`INSERT INTO users (email) VALUES ($1) RETURNING id`, [`pre-approval-probe-${randomUUID()}@example.com`]));
  userId = userResult.rows[0]!.id;
});

afterAll(async () => {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
  await asAdmin((c) => c.query('DELETE FROM users WHERE id = $1', [userId]));
  await pool.end();
});

describe('PreApprovalRepository', () => {
  it('AC1: a playbook is not pre-approved until explicitly granted', async () => {
    const isPreApproved = await withTenantContext(tenantId, () => new PreApprovalRepository(pool).isPreApproved('revoke_sessions'));
    expect(isPreApproved).toBe(false);
  });

  it('T1/AC4: granting makes a playbook pre-approved and is audited', async () => {
    await withTenantContext(tenantId, () => new PreApprovalRepository(pool).grant('revoke_sessions', userId));
    const isPreApproved = await withTenantContext(tenantId, () => new PreApprovalRepository(pool).isPreApproved('revoke_sessions'));
    expect(isPreApproved).toBe(true);

    const audit = await asAdmin(
      (c) => c.query(`SELECT actor_type, actor_id FROM audit_log WHERE tenant_id = $1 AND action = 'pre_approval_granted' AND subject_id = 'revoke_sessions'`, [tenantId]),
      tenantId,
    );
    expect(audit.rows).toEqual([{ actor_type: 'human', actor_id: userId }]);
  });

  it('granting an already-active playbook again is a harmless no-op, not a conflict', async () => {
    await withTenantContext(tenantId, () => new PreApprovalRepository(pool).grant('delete_inbox_rule', userId));
    await expect(withTenantContext(tenantId, () => new PreApprovalRepository(pool).grant('delete_inbox_rule', userId))).resolves.toBeUndefined();
  });

  it('T2: the application layer refuses to pre-approve a destructive playbook', async () => {
    await expect(withTenantContext(tenantId, () => new PreApprovalRepository(pool).grant('disable_user', userId))).rejects.toThrow(DestructivePlaybookCannotBePreApprovedError);

    const isPreApproved = await withTenantContext(tenantId, () => new PreApprovalRepository(pool).isPreApproved('disable_user'));
    expect(isPreApproved).toBe(false);
  });

  it("T2: the database's own CHECK constraint ALSO refuses a destructive playbook, independent of the application check", async () => {
    await expect(
      asAdmin((c) => c.query(`INSERT INTO tenant_pre_approvals (tenant_id, playbook, granted_by) VALUES ($1, 'isolate_device', $2)`, [tenantId, userId]), tenantId),
    ).rejects.toThrow(/tenant_pre_approvals_no_destructive_playbooks/);
  });

  it('T3: revoking takes effect immediately — isPreApproved flips back to false, and is audited', async () => {
    await withTenantContext(tenantId, () => new PreApprovalRepository(pool).grant('block_ip', userId));
    expect(await withTenantContext(tenantId, () => new PreApprovalRepository(pool).isPreApproved('block_ip'))).toBe(true);

    const revoked = await withTenantContext(tenantId, () => new PreApprovalRepository(pool).revoke('block_ip', userId));
    expect(revoked).toBe(true);
    expect(await withTenantContext(tenantId, () => new PreApprovalRepository(pool).isPreApproved('block_ip'))).toBe(false);

    const audit = await asAdmin(
      (c) => c.query(`SELECT actor_type, actor_id FROM audit_log WHERE tenant_id = $1 AND action = 'pre_approval_revoked' AND subject_id = 'block_ip'`, [tenantId]),
      tenantId,
    );
    expect(audit.rows).toEqual([{ actor_type: 'human', actor_id: userId }]);
  });

  it('revoking an already-revoked (or never-granted) playbook is a no-op, not an error', async () => {
    const revoked = await withTenantContext(tenantId, () => new PreApprovalRepository(pool).revoke('force_password_reset', userId));
    expect(revoked).toBe(false);
  });

  it('a tenant can re-grant a playbook after revoking it', async () => {
    // 'revoke_sessions' is already active from an earlier test in this
    // suite — revoke it, confirm it's off, then grant it again.
    await withTenantContext(tenantId, () => new PreApprovalRepository(pool).revoke('revoke_sessions', userId));
    expect(await withTenantContext(tenantId, () => new PreApprovalRepository(pool).isPreApproved('revoke_sessions'))).toBe(false);

    await withTenantContext(tenantId, () => new PreApprovalRepository(pool).grant('revoke_sessions', userId));
    expect(await withTenantContext(tenantId, () => new PreApprovalRepository(pool).isPreApproved('revoke_sessions'))).toBe(true);
  });
});
