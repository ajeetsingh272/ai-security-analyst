/**
 * P6-10: the three real pricing tiers from `tenants.plan`'s own CHECK
 * constraint ('msp', 'startup', 'small_business', plus 'trial') —
 * modelled with their seat and event-volume limits, and the revenue
 * figure a per-tenant margin calculation compares cost of goods
 * against.
 *
 * `evaluateLimit`'s soft/hard shape mirrors apps/analyst/src/
 * cost-budget.ts's own `evaluateBudget` exactly (1.5x the allowance is
 * "soft", a separately-configured hard cap is "hard") — the same
 * judgment call, generalised from $ spend to any metered quantity,
 * not a new one invented for this ticket.
 */

export type PlanTier = 'msp' | 'startup' | 'small_business' | 'trial';

export interface LimitBand {
  /** The plan's normal allowance for this metric. */
  allowance: number;
  /** A separately configured ceiling — not a fixed multiple of
   * `allowance` (same reasoning as PlanBudget.hardCapUsd: the brief
   * never specifies a ratio between the two, so each tier states both
   * numbers explicitly rather than this module inventing one). */
  hardCap: number;
}

export interface PlanLimits {
  seats: LimitBand;
  /** Signals detected per day — see @sentinel/db's
   * `countEventVolumeSince` for why this is the Postgres-side proxy
   * used for "event volume" (true ingested-event counts live only in
   * ClickHouse, unavailable in this sandbox). */
  eventVolumePerDay: LimitBand;
  /** Mirrors apps/analyst/src/cost-budget.ts's own `PLAN_BUDGETS`
   * numbers exactly (same four tiers, same allowanceUsd/hardCapUsd) —
   * necessarily a SEPARATE constant, not a shared import: apps/api and
   * apps/analyst are separate deployable processes (the same
   * constraint every other wire-contract type in this repo is
   * duplicated across, never imported across). Kept here so this
   * ticket's own ops view and sweep can evaluate cost status without
   * apps/api reaching into apps/analyst, while still describing the
   * exact same real dollar limits apps/analyst already enforces
   * per-case. If these two ever drift, that is a real bug — keep both
   * in sync by hand. */
  costUsdPerDay: LimitBand;
}

/** Used for any plan tier not named below — the same fail-conservative
 * shape cost-budget.ts's own DEFAULT_BUDGET uses: an unrecognised tier
 * degrades to the MOST conservative limits, never the most permissive. */
const DEFAULT_LIMITS: PlanLimits = {
  seats: { allowance: 3, hardCap: 5 },
  eventVolumePerDay: { allowance: 500, hardCap: 1_500 },
  costUsdPerDay: { allowance: 2, hardCap: 6 },
};

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  msp: {
    seats: { allowance: 50, hardCap: 100 },
    eventVolumePerDay: { allowance: 50_000, hardCap: 150_000 },
    costUsdPerDay: { allowance: 40, hardCap: 120 },
  },
  small_business: {
    seats: { allowance: 15, hardCap: 30 },
    eventVolumePerDay: { allowance: 10_000, hardCap: 30_000 },
    costUsdPerDay: { allowance: 15, hardCap: 45 },
  },
  startup: {
    seats: { allowance: 8, hardCap: 20 },
    eventVolumePerDay: { allowance: 5_000, hardCap: 15_000 },
    costUsdPerDay: { allowance: 10, hardCap: 30 },
  },
  trial: {
    seats: { allowance: 3, hardCap: 5 },
    eventVolumePerDay: { allowance: 500, hardCap: 1_500 },
    costUsdPerDay: { allowance: 2, hardCap: 6 },
  },
};

export function limitsFor(plan: string | null): PlanLimits {
  if (plan !== null && Object.hasOwn(PLAN_LIMITS, plan)) {
    return PLAN_LIMITS[plan as PlanTier];
  }
  return DEFAULT_LIMITS;
}

/** AC3/cost-budget.ts's own precedent: "exceeding 1.5x the allowance." */
export const SOFT_THRESHOLD_MULTIPLE = 1.5;

export type LimitStatus = 'ok' | 'soft_exceeded' | 'hard_exceeded';

export function evaluateLimit(usage: number, band: LimitBand): LimitStatus {
  if (usage >= band.hardCap) return 'hard_exceeded';
  if (usage >= band.allowance * SOFT_THRESHOLD_MULTIPLE) return 'soft_exceeded';
  return 'ok';
}

const STATUS_SEVERITY: Record<LimitStatus, number> = { ok: 0, soft_exceeded: 1, hard_exceeded: 2 };

/** The worst (most severe) of several independently-evaluated axes —
 * a tenant over its event-volume limit degrades the same way as one
 * over its seat limit, regardless of which specific metric tripped. */
export function worstStatus(...statuses: LimitStatus[]): LimitStatus {
  return statuses.reduce((worst, s) => (STATUS_SEVERITY[s] > STATUS_SEVERITY[worst] ? s : worst), 'ok' as LimitStatus);
}

/** Modelled monthly revenue per tier — 'trial' is deliberately $0 (a
 * trial tenant has no revenue to compare against; see computeMargin's
 * own handling of that case rather than dividing by zero). */
export const PLAN_PRICING: Record<PlanTier, { monthlyPriceUsd: number }> = {
  msp: { monthlyPriceUsd: 1_500 },
  small_business: { monthlyPriceUsd: 400 },
  startup: { monthlyPriceUsd: 200 },
  trial: { monthlyPriceUsd: 0 },
};

export function pricingFor(plan: string | null): { monthlyPriceUsd: number } {
  if (plan !== null && Object.hasOwn(PLAN_PRICING, plan)) {
    return PLAN_PRICING[plan as PlanTier];
  }
  return PLAN_PRICING.trial;
}

export interface Margin {
  revenueUsd: number;
  cogsUsd: number;
  marginUsd: number;
  /** `null` when revenue is $0 (a trial tenant) — a percentage of zero
   * revenue is not a meaningful number, and reporting it as -Infinity
   * or 0 would both be dishonest. `marginUsd` alone (always `-cogsUsd`
   * for a $0-revenue tier) is the correct, honest number to show in
   * that case. */
  marginPct: number | null;
}

/** T3: the per-tenant margin an operations view compares against
 * revenue — COGS here is whatever the caller metered as this tenant's
 * cost of goods for the SAME period `revenueUsd` covers (in practice,
 * the tenant's own metered LLM spend — see this package's own doc
 * comment on why that is the dominant, and only currently-measured,
 * variable cost component; infrastructure/hosting cost-per-tenant is
 * out of this ticket's scope, disclosed rather than estimated). */
export function computeMargin(plan: string | null, cogsUsd: number): Margin {
  const revenueUsd = pricingFor(plan).monthlyPriceUsd;
  const marginUsd = revenueUsd - cogsUsd;
  const marginPct = revenueUsd === 0 ? null : (marginUsd / revenueUsd) * 100;
  return { revenueUsd, cogsUsd, marginUsd, marginPct };
}
