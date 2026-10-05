/**
 * MSP cross-tenant access (P0-09 AC3): "the MSP role grants scoped access to
 * explicitly linked client tenants and nothing else."
 *
 * Must run inside the user's OWN tenant context (their home tenant, where
 * their membership row lives) — the msp_links RLS policy
 * (0003_msp_links_rls.sql) only shows a row to one of its two named parties,
 * so this read only succeeds at all because it runs as the MSP side of a
 * potential link. That is deliberate: this function cannot be fooled into
 * checking access FROM an arbitrary tenant that was never the caller's own.
 */
import { TenantScopedRepository } from '@sentinel/db';
import type { Pool } from 'pg';

class MspLinkRepository extends TenantScopedRepository {
  async isLinkedTo(clientTenantId: string): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT 1 FROM msp_links
          WHERE msp_tenant_id = current_setting('app.tenant_id')::uuid
            AND client_tenant_id = $1
            AND revoked_at IS NULL`,
        [clientTenantId],
      );
      return rows.length > 0;
    });
  }
}

/**
 * Must be called from inside `withTenantContext(homeTenantId, ...)` —
 * `homeTenantId` being the caller's own tenant, never the target. Returns
 * true for the trivial case (acting on one's own tenant) without touching
 * the database at all, and otherwise only for an explicit, non-revoked
 * `msp_links` grant from the caller's tenant to `targetTenantId` — never the
 * other direction (a client tenant does not get MSP-style access INTO the
 * MSP that manages it just because a link exists).
 */
export async function canActAsTenant(
  pool: Pool,
  homeTenantId: string,
  targetTenantId: string,
): Promise<boolean> {
  if (homeTenantId === targetTenantId) return true;
  return new MspLinkRepository(pool).isLinkedTo(targetTenantId);
}
