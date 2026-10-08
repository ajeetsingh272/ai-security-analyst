/**
 * P6-06: the MSP console's own "which clients am I linked to" query —
 * the read side of P0-09's `msp_links` table, which until now only had
 * a write path (apps/api/src/auth/msp-access.ts's `canActAsTenant`
 * checks one link at a time; nothing listed every link a tenant holds).
 *
 * Runs under the CALLER's own tenant context (the MSP's own tenant),
 * the same way `canActAsTenant` must — `msp_links`' own RLS policy only
 * ever shows a row to one of its two named parties, so this read only
 * succeeds because it runs as the MSP side of the link, never because
 * of some separate authorization check layered on top.
 */
import { TenantScopedRepository } from '../tenant-context.js';

export interface LinkedClient {
  clientTenantId: string;
  clientTenantName: string;
}

export class MspRepository extends TenantScopedRepository {
  async listLinkedClients(): Promise<LinkedClient[]> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query<{ client_tenant_id: string; name: string }>(
        `SELECT ml.client_tenant_id, t.name
           FROM msp_links ml
           JOIN tenants t ON t.id = ml.client_tenant_id
          WHERE ml.msp_tenant_id = current_setting('app.tenant_id')::uuid
            AND ml.revoked_at IS NULL
          ORDER BY t.name`,
      );
      return rows.map((r) => ({ clientTenantId: r.client_tenant_id, clientTenantName: r.name }));
    });
  }
}
