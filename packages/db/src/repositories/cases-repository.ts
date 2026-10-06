/**
 * The reference implementation of `TenantScopedRepository`.
 *
 * Exists partly to be useful and partly to prove the pattern compiles and
 * runs end to end — P0-05's acceptance criteria are about the base class's
 * behaviour, and the clearest way to show it holds is a repository that
 * actually queries a real table.
 */
import { TenantScopedRepository } from '../tenant-context.js';

export interface CaseRow {
  id: string;
  tenantId: string;
  severity: string | null;
  title: string | null;
  signalCount: number;
  createdAt: string;
}

function mapRow(row: Record<string, unknown>): CaseRow {
  return {
    id: String(row['id']),
    tenantId: String(row['tenant_id']),
    severity: (row['severity'] as string | null) ?? null,
    title: (row['title'] as string | null) ?? null,
    signalCount: Number(row['signal_count']),
    createdAt: String(row['created_at']),
  };
}

export class CasesRepository extends TenantScopedRepository {
  /**
   * Deliberately has NO `WHERE tenant_id = ...` clause. That omission is the
   * point of this method: the query relies entirely on the RLS policy set up
   * by `withTransaction`'s `SET LOCAL app.tenant_id`, which is exactly
   * P0-05 T2 — "a query deliberately written without a tenant_id filter still
   * returns only the current tenant's rows." If this method ever starts
   * returning another tenant's cases, the bug is in the database layer, not
   * a missing filter here — which is precisely the property RLS exists to
   * guarantee.
   */
  async findAll(): Promise<CaseRow[]> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        'SELECT id, tenant_id, severity, title, signal_count, created_at FROM cases ORDER BY created_at DESC',
      );
      return rows.map(mapRow);
    });
  }

  async findById(id: string): Promise<CaseRow | null> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        'SELECT id, tenant_id, severity, title, signal_count, created_at FROM cases WHERE id = $1',
        [id],
      );
      return rows.length > 0 ? mapRow(rows[0]) : null;
    });
  }
}
