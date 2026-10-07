/**
 * P2-12 — ADR-0004's own named escape hatch: a small interpreted
 * "hotfix rule" path for urgent detections, capped at 10 active rules
 * platform-wide and expiring automatically after 7 days.
 *
 * Deliberately NOT a `TenantScopedRepository` — hotfix_rules carries no
 * tenant_id (0008_hotfix_rules.sql's own doc comment explains why: the
 * cap is a single global count, not per-tenant) — so there is no tenant
 * context to require at construction, and no RLS policy for a role
 * switch to engage. Queries still run as `sentinel_app`, not the pool's
 * default (superuser) role, for the same least-privilege reason every
 * other repository in this package switches role — there just isn't a
 * `SET LOCAL app.tenant_id` to go with it here.
 */
import type { Pool, PoolClient } from 'pg';

const APP_ROLE = 'sentinel_app';
const MAX_ACTIVE_RULES = 10;

export interface HotfixRuleRow {
  id: string;
  ruleId: string;
  ruleTitle: string;
  ruleYaml: string;
  reason: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
}

function mapRow(row: Record<string, unknown>): HotfixRuleRow {
  return {
    id: String(row['id']),
    ruleId: String(row['rule_id']),
    ruleTitle: String(row['rule_title']),
    ruleYaml: String(row['rule_yaml']),
    reason: String(row['reason']),
    createdBy: String(row['created_by']),
    createdAt: String(row['created_at']),
    expiresAt: String(row['expires_at']),
    revokedAt: (row['revoked_at'] as string | null) ?? null,
    revokedBy: (row['revoked_by'] as string | null) ?? null,
  };
}

export class HotfixRuleEmptyReasonError extends Error {
  constructor() {
    super('A hotfix rule reason is required and cannot be blank.');
    this.name = 'HotfixRuleEmptyReasonError';
  }
}

/** AC1: "Maximum 10 active hotfix rules platform-wide." */
export class HotfixRuleCapExceededError extends Error {
  constructor() {
    super(`No more than ${MAX_ACTIVE_RULES} hotfix rules may be active at once, platform-wide.`);
    this.name = 'HotfixRuleCapExceededError';
  }
}

export interface CreateHotfixRuleInput {
  ruleId: string;
  ruleTitle: string;
  ruleYaml: string;
  reason: string;
  createdBy: string;
}

const SELECT_COLUMNS =
  'id, rule_id, rule_title, rule_yaml, reason, created_by, created_at, expires_at, revoked_at, revoked_by';

export class HotfixRulesRepository {
  constructor(private readonly pool: Pool) {}

  private async withRole<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
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

  /**
   * AC1's cap, enforced here rather than as a single-row CHECK
   * constraint (Postgres cannot express "fewer than N sibling rows
   * satisfy X" that way). `pg_advisory_xact_lock` serializes concurrent
   * creates against the SAME count-then-insert race, the identical
   * mechanism AuditLogWriter.insert already uses to serialize its own
   * hash chain — a lock keyed by a fixed constant, not a tenant id,
   * since this cap is global, not per-tenant.
   */
  async create(input: CreateHotfixRuleInput): Promise<HotfixRuleRow> {
    if (input.reason.trim().length === 0) {
      throw new HotfixRuleEmptyReasonError();
    }
    return this.withRole(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['hotfix_rules_cap']);

      const { rows: countRows } = await client.query<{ count: string }>(
        `SELECT count(*) FROM hotfix_rules WHERE revoked_at IS NULL AND expires_at > now()`,
      );
      if (Number(countRows[0]?.count ?? 0) >= MAX_ACTIVE_RULES) {
        throw new HotfixRuleCapExceededError();
      }

      const { rows } = await client.query(
        `INSERT INTO hotfix_rules (rule_id, rule_title, rule_yaml, reason, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${SELECT_COLUMNS}`,
        [input.ruleId, input.ruleTitle, input.ruleYaml, input.reason, input.createdBy],
      );
      return mapRow(rows[0]);
    });
  }

  /**
   * AC4: "Active hotfix rules are listed on the operations dashboard
   * with their expiry" — exposed via apps/api only; apps/dashboard has
   * no real UI framework yet (P6-01/P6-08's own scope), the same
   * precedent every other "dashboard" AC in this codebase has followed.
   */
  async listActive(): Promise<HotfixRuleRow[]> {
    return this.withRole(async (client) => {
      const { rows } = await client.query(
        `SELECT ${SELECT_COLUMNS} FROM hotfix_rules
         WHERE revoked_at IS NULL AND expires_at > now()
         ORDER BY created_at DESC`,
      );
      return rows.map(mapRow);
    });
  }

  async revoke(id: string, revokedBy: string): Promise<HotfixRuleRow | null> {
    return this.withRole(async (client) => {
      const { rows } = await client.query(
        `UPDATE hotfix_rules SET revoked_at = now(), revoked_by = $2
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING ${SELECT_COLUMNS}`,
        [id, revokedBy],
      );
      return rows.length > 0 ? mapRow(rows[0]) : null;
    });
  }
}
