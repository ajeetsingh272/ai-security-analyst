/**
 * P4-06: per-call LLM token usage and cost, and the two reads the cost
 * budget guard needs — this tenant's own spend since the start of
 * today, and this tenant's own plan tier (`tenants.plan`'s real CHECK
 * constraint values: 'msp', 'startup', 'small_business', 'trial').
 *
 * `tenants` itself has no row-level security (confirmed: no
 * `CREATE POLICY ... ON tenants` anywhere in
 * db/postgres/migrations/0001_foundation.sql — it is the root table,
 * not a tenant-scoped one), so `planTier` filters explicitly by
 * `WHERE id = $1` rather than relying on RLS the way every OTHER method
 * in this class does for `llm_usage` itself.
 */
import { TenantScopedRepository } from '../tenant-context.js';

export interface UsageRecord {
  caseId: string;
  model: string;
  stage: 'triage' | 'investigation';
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export class LlmUsageRepository extends TenantScopedRepository {
  async record(usage: UsageRecord): Promise<void> {
    await this.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO llm_usage (tenant_id, case_id, model, stage, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          this.tenantId,
          usage.caseId,
          usage.model,
          usage.stage,
          usage.inputTokens,
          usage.outputTokens,
          usage.cacheReadTokens,
          usage.cacheCreationTokens,
          usage.costUsd,
        ],
      );
    });
  }

  /** Deliberately has no explicit `tenant_id` filter — relies entirely
   * on `llm_usage`'s own RLS policy, the same P0-05 T2 guarantee
   * `CasesRepository.findAll` already demonstrates. */
  async dailySpendUsd(day: Date): Promise<number> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query<{ total: string | null }>(
        `SELECT SUM(cost_usd) AS total FROM llm_usage
          WHERE recorded_at >= $1::date AND recorded_at < $1::date + INTERVAL '1 day'`,
        [day.toISOString()],
      );
      return Number(rows[0]?.total ?? 0);
    });
  }

  async planTier(): Promise<string | null> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query<{ plan: string }>('SELECT plan FROM tenants WHERE id = $1', [this.tenantId]);
      return rows[0]?.plan ?? null;
    });
  }
}
