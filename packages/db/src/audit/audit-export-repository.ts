/**
 * P5-09 AC5: "an audit export for a tenant and date range is
 * available for compliance" — the read side of the hash-chained log
 * (audit-log-writer.ts is write-only by design; this is deliberately
 * a separate class, the same read/write split ConnectorsRepository
 * has from go/sentinelconnector's own HealthRecorder).
 *
 * Returns `prevHash`/`entryHash` as hex, not raw Buffers — a
 * compliance reviewer (or their own tooling) re-verifying this
 * exported slice against `scripts/chain-verifier.mjs`'s own
 * `computeEntryHash` needs the exact bytes in a transportable form,
 * not a JSON-serialised Buffer object `{type:'Buffer', data:[...]}`
 * that round-trips incorrectly through most JSON consumers.
 */
import { TenantScopedRepository } from '../tenant-context.js';
import type { ActorType } from './audit-log-writer.js';

export interface AuditExportEntry {
  id: string;
  occurredAt: string;
  actorType: ActorType;
  actorId: string;
  action: string;
  subjectType: string;
  subjectId: string;
  payload: unknown;
  prevHash: string;
  entryHash: string;
}

export class AuditExportRepository extends TenantScopedRepository {
  /** T4: every entry with `occurred_at` in `[from, to)` for this
   * tenant, and nothing outside it — RLS already guarantees "nothing
   * from another tenant" the same way every other read in this
   * package does; the date bound is this method's own job. */
  async exportRange(from: Date, to: Date): Promise<AuditExportEntry[]> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query<{
        id: string;
        occurred_at: string;
        actor_type: ActorType;
        actor_id: string;
        action: string;
        subject_type: string;
        subject_id: string;
        payload: unknown;
        prev_hash: Buffer;
        entry_hash: Buffer;
      }>(
        `SELECT id, occurred_at, actor_type, actor_id, action, subject_type, subject_id, payload, prev_hash, entry_hash
         FROM audit_log
         WHERE tenant_id = $1 AND occurred_at >= $2 AND occurred_at < $3
         ORDER BY id ASC`,
        [this.tenantId, from.toISOString(), to.toISOString()],
      );
      return rows.map((r) => ({
        id: r.id,
        occurredAt: r.occurred_at,
        actorType: r.actor_type,
        actorId: r.actor_id,
        action: r.action,
        subjectType: r.subject_type,
        subjectId: r.subject_id,
        payload: r.payload,
        prevHash: r.prev_hash.toString('hex'),
        entryHash: r.entry_hash.toString('hex'),
      }));
    });
  }
}
