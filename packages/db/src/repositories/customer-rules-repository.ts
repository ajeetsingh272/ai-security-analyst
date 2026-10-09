/**
 * P7-10 / ADR-0012: the tenant-self-service counterpart to
 * HotfixRulesRepository's platform-only escape hatch. Unlike
 * hotfix_rules, customer_rules genuinely IS tenant data — a
 * TenantScopedRepository, RLS-enforced, no exceptions (ADR-0008).
 *
 * This repository only ever writes `pending_validation` rows and
 * reads/deletes a tenant's own rows. The authoritative Sigma parse,
 * the ADR-0012 §1 complexity validation, the §3 fixture check, and
 * every transition to 'active'/'rejected'/'suspended_resource_limit'
 * happen exclusively in Go (services/detect/internal/customerrules) —
 * never duplicated here, the same "one authoritative parser" boundary
 * hotfix-rules.ts's own extractDisplayFields already respects.
 */
import { TenantScopedRepository } from '../tenant-context.js';

const MAX_ACTIVE_RULES_PER_TENANT = 25;

export type CustomerRuleStatus = 'pending_validation' | 'active' | 'rejected' | 'suspended_resource_limit' | 'disabled';

export interface CustomerRuleRow {
  id: string;
  tenantId: string;
  ruleId: string;
  ruleTitle: string;
  ruleYaml: string;
  status: CustomerRuleStatus;
  rejectionReason: string | null;
  createdBy: string;
  createdAt: string;
  validatedAt: string | null;
}

function mapRow(row: Record<string, unknown>): CustomerRuleRow {
  return {
    id: String(row['id']),
    tenantId: String(row['tenant_id']),
    ruleId: String(row['rule_id']),
    ruleTitle: String(row['rule_title']),
    ruleYaml: String(row['rule_yaml']),
    status: row['status'] as CustomerRuleStatus,
    rejectionReason: (row['rejection_reason'] as string | null) ?? null,
    createdBy: String(row['created_by']),
    createdAt: new Date(row['created_at'] as string | Date).toISOString(),
    validatedAt: row['validated_at'] ? new Date(row['validated_at'] as string | Date).toISOString() : null,
  };
}

export class CustomerRuleCapExceededError extends Error {
  constructor() {
    super(`No more than ${MAX_ACTIVE_RULES_PER_TENANT} customer rules may be active or pending at once, per tenant.`);
    this.name = 'CustomerRuleCapExceededError';
  }
}

export interface CreateCustomerRuleInput {
  ruleId: string;
  ruleTitle: string;
  ruleYaml: string;
  positiveFixture: Record<string, string>;
  negativeFixture: Record<string, string>;
  createdBy: string;
}

const SELECT_COLUMNS = 'id, tenant_id, rule_id, rule_title, rule_yaml, status, rejection_reason, created_by, created_at, validated_at';

export class CustomerRulesRepository extends TenantScopedRepository {
  /**
   * ADR-0012's own per-tenant cap (25), enforced the same way
   * HotfixRulesRepository.create enforces its own global cap — a
   * count-then-insert serialized by pg_advisory_xact_lock, keyed by
   * THIS tenant's id (not a fixed constant, since the cap is
   * per-tenant, not platform-wide).
   */
  async create(input: CreateCustomerRuleInput): Promise<CustomerRuleRow> {
    return this.withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`customer_rules_cap:${this.tenantId}`]);

      const { rows: countRows } = await client.query<{ count: string }>(
        `SELECT count(*) FROM customer_rules WHERE tenant_id = $1 AND status IN ('pending_validation', 'active')`,
        [this.tenantId],
      );
      if (Number(countRows[0]?.count ?? 0) >= MAX_ACTIVE_RULES_PER_TENANT) {
        throw new CustomerRuleCapExceededError();
      }

      const { rows } = await client.query(
        `INSERT INTO customer_rules (tenant_id, rule_id, rule_title, rule_yaml, positive_fixture, negative_fixture, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${SELECT_COLUMNS}`,
        [this.tenantId, input.ruleId, input.ruleTitle, input.ruleYaml, JSON.stringify(input.positiveFixture), JSON.stringify(input.negativeFixture), input.createdBy],
      );
      return mapRow(rows[0]);
    });
  }

  async list(): Promise<CustomerRuleRow[]> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(`SELECT ${SELECT_COLUMNS} FROM customer_rules ORDER BY created_at DESC`);
      return rows.map(mapRow);
    });
  }

  /** A tenant's own voluntary stop — distinct from the Go worker's
   * `suspended_resource_limit` transition, which this method never
   * writes (RLS would in any case stop this role from doing anything
   * cross-tenant, but the status value itself is also reserved). */
  async disable(id: string): Promise<CustomerRuleRow | null> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE customer_rules SET status = 'disabled', updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND status IN ('pending_validation', 'active', 'suspended_resource_limit')
         RETURNING ${SELECT_COLUMNS}`,
        [id, this.tenantId],
      );
      return rows.length > 0 ? mapRow(rows[0]) : null;
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const { rowCount } = await client.query(`DELETE FROM customer_rules WHERE id = $1 AND tenant_id = $2`, [id, this.tenantId]);
      return (rowCount ?? 0) > 0;
    });
  }
}
