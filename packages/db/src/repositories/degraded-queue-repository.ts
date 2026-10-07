/**
 * P4-10 AC3: cases owed a re-investigation once the LLM provider
 * recovers. `enqueue` is idempotent (`ON CONFLICT DO NOTHING` on the
 * table's own `UNIQUE (tenant_id, case_id)`) — the same case degrading
 * twice while the circuit stays open must not queue it twice, which
 * would otherwise risk re-investigating it twice on recovery.
 */
import type { Pool } from 'pg';
import { TenantScopedRepository } from '../tenant-context.js';

export interface DegradedQueueRow {
  id: string;
  caseId: string;
  reason: string;
  queuedAt: string;
}

export class DegradedQueueRepository extends TenantScopedRepository {
  async enqueue(caseId: string, reason: string): Promise<void> {
    await this.withTransaction((client) =>
      client.query(
        `INSERT INTO analyst_degraded_queue (tenant_id, case_id, reason) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, case_id) DO NOTHING`,
        [this.tenantId, caseId, reason],
      ),
    );
  }

  async claimPending(limit: number): Promise<DegradedQueueRow[]> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string; case_id: string; reason: string; queued_at: string }>(
        `SELECT id, case_id, reason, queued_at FROM analyst_degraded_queue WHERE processed_at IS NULL ORDER BY queued_at LIMIT $1`,
        [limit],
      );
      return rows.map((r) => ({ id: r.id, caseId: r.case_id, reason: r.reason, queuedAt: r.queued_at }));
    });
  }

  async markProcessed(id: string): Promise<void> {
    await this.withTransaction((client) => client.query('UPDATE analyst_degraded_queue SET processed_at = now() WHERE id = $1', [id]));
  }
}

/**
 * Cross-tenant by construction — mirrors
 * `services/correlate/cmd/correlate/main.go`'s own `runQuietPeriodSweep`,
 * which lists tenants via the pool's own default connection
 * specifically because draining a provider-recovery queue is a
 * platform-wide sweep, not one tenant's own request. Every actual
 * read/write of `analyst_degraded_queue` itself still goes through
 * `DegradedQueueRepository` above, tenant-scoped via
 * `withTenantContext` like everything else this package writes.
 */
export async function listTenantsWithPendingDegradedCases(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ tenant_id: string }>('SELECT DISTINCT tenant_id FROM analyst_degraded_queue WHERE processed_at IS NULL');
  return rows.map((r) => r.tenant_id);
}
