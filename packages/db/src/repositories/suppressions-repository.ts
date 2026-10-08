/**
 * P2-10 (TG3: "Nothing is hidden — dismissals are surfaced").
 *
 * A suppression silences a noisy rule — optionally scoped to one entity,
 * otherwise every entity for that tenant+rule — for a bounded time, with a
 * mandatory reason. AC3 ("suppressed signals are still stored and counted,
 * just not escalated") is enforced in services/detect, not here: this
 * repository only records who decided to suppress what, why, and until when.
 */
import { TenantScopedRepository } from '../tenant-context.js';

export interface SuppressionRow {
  id: string;
  tenantId: string;
  ruleId: string;
  entityId: string | null;
  reason: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  /** P6-08: "listed with their creator" — resolved via a join to `users`
   * rather than leaving the dashboard to show a bare UUID. `users` is a
   * global (non-tenant-scoped) table, so this is a plain join, not a
   * second tenant-scoped query. */
  createdByEmail: string | null;
  revokedByEmail: string | null;
  /** AC5: "what they have suppressed" — incremented atomically by
   * services/detect/internal/suppression.PostgresChecker every time this
   * suppression actually silences a signal. */
  suppressedCount: number;
}

function mapRow(row: Record<string, unknown>): SuppressionRow {
  return {
    id: String(row['id']),
    tenantId: String(row['tenant_id']),
    ruleId: String(row['rule_id']),
    entityId: (row['entity_id'] as string | null) ?? null,
    reason: String(row['reason']),
    createdBy: String(row['created_by']),
    createdAt: String(row['created_at']),
    expiresAt: String(row['expires_at']),
    revokedAt: (row['revoked_at'] as string | null) ?? null,
    revokedBy: (row['revoked_by'] as string | null) ?? null,
    createdByEmail: (row['created_by_email'] as string | null) ?? null,
    revokedByEmail: (row['revoked_by_email'] as string | null) ?? null,
    suppressedCount: Number(row['suppressed_count']),
  };
}

/**
 * Thrown by `create`/`renew` for a blank reason, before any query runs. The
 * table's own CHECK constraint catches this too (defence in depth for any
 * other insert path), but a thrown, named error lets the route return a
 * clean 400 instead of surfacing a raw constraint-violation message.
 */
export class SuppressionEmptyReasonError extends Error {
  constructor() {
    super('A suppression reason is required and cannot be blank.');
    this.name = 'SuppressionEmptyReasonError';
  }
}

export interface CreateSuppressionInput {
  ruleId: string;
  entityId?: string | null;
  reason: string;
  createdBy: string;
  expiresAt: Date;
}

export interface RenewSuppressionInput {
  reason: string;
  expiresAt: Date;
}

const SELECT_COLUMNS =
  's.id, s.tenant_id, s.rule_id, s.entity_id, s.reason, s.created_by, s.created_at, s.expires_at, s.revoked_at, s.revoked_by, s.suppressed_count, ' +
  'creator.email AS created_by_email, revoker.email AS revoked_by_email';
const SELECT_FROM = 'FROM suppressions s LEFT JOIN users creator ON creator.id = s.created_by LEFT JOIN users revoker ON revoker.id = s.revoked_by';

export class SuppressionsRepository extends TenantScopedRepository {
  async create(input: CreateSuppressionInput): Promise<SuppressionRow> {
    if (input.reason.trim().length === 0) {
      throw new SuppressionEmptyReasonError();
    }
    return this.withTransaction(async (client) => {
      const { rows: inserted } = await client.query<{ id: string }>(
        `INSERT INTO suppressions (tenant_id, rule_id, entity_id, reason, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [this.tenantId, input.ruleId, input.entityId ?? null, input.reason, input.createdBy, input.expiresAt],
      );
      const { rows } = await client.query(`SELECT ${SELECT_COLUMNS} ${SELECT_FROM} WHERE s.id = $1`, [inserted[0]!.id]);
      return mapRow(rows[0]);
    });
  }

  /** AC5: "the dashboard shows active suppressions" — consumed by P6-08's
   * dashboard UI via GET /suppressions. */
  async listActive(): Promise<SuppressionRow[]> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT ${SELECT_COLUMNS} ${SELECT_FROM}
         WHERE s.revoked_at IS NULL AND s.expires_at > now()
         ORDER BY s.created_at DESC`,
      );
      return rows.map(mapRow);
    });
  }

  async revoke(id: string, revokedBy: string): Promise<SuppressionRow | null> {
    return this.withTransaction(async (client) => {
      const { rows: updated } = await client.query<{ id: string }>(
        `UPDATE suppressions SET revoked_at = now(), revoked_by = $2
         WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
        [id, revokedBy],
      );
      if (updated.length === 0) return null;
      const { rows } = await client.query(`SELECT ${SELECT_COLUMNS} ${SELECT_FROM} WHERE s.id = $1`, [id]);
      return mapRow(rows[0]);
    });
  }

  /**
   * AC4: "expire by default and require explicit renewal" — renewing
   * records a fresh reason rather than silently extending the old one; the
   * audit-logged "why renewed" lives at the route layer, same as create.
   */
  async renew(id: string, input: RenewSuppressionInput): Promise<SuppressionRow | null> {
    if (input.reason.trim().length === 0) {
      throw new SuppressionEmptyReasonError();
    }
    return this.withTransaction(async (client) => {
      const { rows: updated } = await client.query<{ id: string }>(
        `UPDATE suppressions SET reason = $2, expires_at = $3
         WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
        [id, input.reason, input.expiresAt],
      );
      if (updated.length === 0) return null;
      const { rows } = await client.query(`SELECT ${SELECT_COLUMNS} ${SELECT_FROM} WHERE s.id = $1`, [id]);
      return mapRow(rows[0]);
    });
  }
}
