/**
 * P4-06: per-tenant daily LLM cost budgets. `PLAN_BUDGETS` mirrors
 * services/correlate/internal/scoring/threshold.go's own `PlanTier`
 * map almost exactly — the same four REAL plan values
 * (`tenants.plan`'s own CHECK constraint: 'msp', 'startup',
 * 'small_business', 'trial'; that Go file's own doc comment records
 * the bug of inventing fictional tier names that silently never
 * matched the schema, which is exactly the mistake copying its real
 * values here avoids), and the same "an unrecognised tier degrades to
 * the most conservative configured budget" shape.
 */
import type { Pool } from 'pg';
import type { Counter } from '@opentelemetry/api';
import { withTenantContext, LlmUsageRepository } from '@sentinel/db';
import { computeCostUsd, type PriceTable, type Usage } from './pricing.js';

export type PlanTier = 'msp' | 'startup' | 'small_business' | 'trial';

export interface PlanBudget {
  /** AC3's own "the plan allowance" — the normal daily budget. */
  allowanceUsd: number;
  /** AC4's own hard cap — a SEPARATELY configured ceiling, not a fixed
   * multiple of `allowanceUsd`: the ticket never specifies a ratio
   * between the two, so each plan tier states both numbers explicitly
   * rather than this file inventing a relationship. */
  hardCapUsd: number;
}

/** Used for any plan tier not named below — the same fail-conservative
 * shape `threshold.go`'s own `defaultThreshold` uses, for the same
 * reason: a typo'd or future tier should degrade to the MOST
 * conservative budget, never the most permissive. */
const DEFAULT_BUDGET: PlanBudget = { allowanceUsd: 2, hardCapUsd: 6 };

export const PLAN_BUDGETS: Record<PlanTier, PlanBudget> = {
  msp: { allowanceUsd: 40, hardCapUsd: 120 },
  small_business: { allowanceUsd: 15, hardCapUsd: 45 },
  startup: { allowanceUsd: 10, hardCapUsd: 30 },
  trial: { allowanceUsd: 2, hardCapUsd: 6 },
};

export function budgetFor(plan: string | null): PlanBudget {
  if (plan !== null && Object.hasOwn(PLAN_BUDGETS, plan)) {
    return PLAN_BUDGETS[plan as PlanTier];
  }
  return DEFAULT_BUDGET;
}

/** AC3's own exact wording: "exceeding 1.5x the plan allowance." */
export const SOFT_THRESHOLD_MULTIPLE = 1.5;

export type BudgetStatus = 'ok' | 'soft_exceeded' | 'hard_exceeded';

export function evaluateBudget(spentUsd: number, budget: PlanBudget): BudgetStatus {
  if (spentUsd >= budget.hardCapUsd) return 'hard_exceeded';
  if (spentUsd >= budget.allowanceUsd * SOFT_THRESHOLD_MULTIPLE) return 'soft_exceeded';
  return 'ok';
}

export interface BudgetCheck {
  status: BudgetStatus;
  spentUsd: number;
  budget: PlanBudget;
  plan: string | null;
}

/** Reads this tenant's plan and today's spend together — the one
 * read `worker.ts` needs before deciding whether to call either
 * model at all for this case. */
export async function checkBudget(pool: Pool, tenantId: string): Promise<BudgetCheck> {
  return withTenantContext(tenantId, async () => {
    const repo = new LlmUsageRepository(pool);
    const plan = await repo.planTier();
    const spentUsd = await repo.dailySpendUsd(new Date());
    const budget = budgetFor(plan);
    return { status: evaluateBudget(spentUsd, budget), spentUsd, budget, plan };
  });
}

/** AC1: "input, output and cache token counts are recorded per case."
 * AC2: cost is computed from `priceTable`, never a literal in this
 * function. Returns the cost recorded, so a caller (worker.ts) can log
 * it without a second read. */
export async function recordUsage(
  pool: Pool,
  tenantId: string,
  caseId: string,
  model: string,
  stage: 'triage' | 'investigation',
  usage: Usage,
  priceTable: PriceTable,
  /** AC5: "cost per tenant is visible on the operations dashboard" —
   * a real OTel counter, incremented in the SAME place the durable
   * Postgres row is written, so the two can never drift apart. */
  costMetric?: Counter,
): Promise<number> {
  const costUsd = computeCostUsd(usage, model, priceTable);
  await withTenantContext(tenantId, () =>
    new LlmUsageRepository(pool).record({
      caseId,
      model,
      stage,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      costUsd,
    }),
  );
  costMetric?.add(costUsd, { tenant_id: tenantId });
  return costUsd;
}
