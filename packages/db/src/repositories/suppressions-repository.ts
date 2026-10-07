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
  'id, tenant_id, rule_id, entity_id, reason, created_by, created_at, expires_at, revoked_at, revoked_by, suppressed_count';

export class SuppressionsRepository extends TenantScopedRepository {
  async create(input: CreateSuppressionInput): Promise<SuppressionRow> {
    if (input.reason.trim().length === 0) {
      throw new SuppressionEmptyReasonError();
    }
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO suppressions (tenant_id, rule_id, entity_id, reason, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${SELECT_COLUMNS}`,
        [this.tenantId, input.ruleId, input.entityId ?? null, input.reason, input.createdBy, input.expiresAt],
      );
      return mapRow(rows[0]);
    });
  }

  /**
   * AC5: "the dashboard shows active suppressions" — exposed today through
   * apps/api only. apps/dashboard has no real UI framework yet (a bare
   * scaffold; the actual dashboard build is P6-01/P6-08), matching the
   * P1-11 AC4 precedent of satisfying a "dashboard" AC via the API surface.
   */
  async listActive(): Promise<SuppressionRow[]> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT ${SELECT_COLUMNS} FROM suppressions
         WHERE revoked_at IS NULL AND expires_at > now()
         ORDER BY created_at DESC`,
      );
      return rows.map(mapRow);
    });
  }

  async revoke(id: string, revokedBy: string): Promise<SuppressionRow | null> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE suppressions SET revoked_at = now(), revoked_by = $2
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING ${SELECT_COLUMNS}`,
        [id, revokedBy],
      );
      return rows.length > 0 ? mapRow(rows[0]) : null;
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
      const { rows } = await client.query(
        `UPDATE suppressions SET reason = $2, expires_at = $3
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING ${SELECT_COLUMNS}`,
        [id, input.reason, input.expiresAt],
      );
      return rows.length > 0 ? mapRow(rows[0]) : null;
    });
  }
}
