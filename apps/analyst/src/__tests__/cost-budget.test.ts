/**
 * P4-06: the plan-budget policy — pure functions, no database.
 * checkBudget/recordUsage's own real-Postgres behavior is exercised in
 * worker.integration.test.ts (T2/T3), the same split
 * services/correlate/internal/baseline/baseline.go uses between its
 * own pure evaluate() and ClickHouse-aware store.go.
 */
import { describe, expect, it } from 'vitest';
import { budgetFor, evaluateBudget, PLAN_BUDGETS, SOFT_THRESHOLD_MULTIPLE } from '../cost-budget.js';

describe('budgetFor', () => {
  it('returns the configured budget for each real plan tier', () => {
    expect(budgetFor('trial')).toEqual(PLAN_BUDGETS.trial);
    expect(budgetFor('msp')).toEqual(PLAN_BUDGETS.msp);
    expect(budgetFor('startup')).toEqual(PLAN_BUDGETS.startup);
    expect(budgetFor('small_business')).toEqual(PLAN_BUDGETS.small_business);
  });

  it('degrades an unrecognised or null plan to the most conservative budget, never the most permissive', () => {
    const mostConservative = Math.min(...Object.values(PLAN_BUDGETS).map((b) => b.allowanceUsd));
    expect(budgetFor('some-future-tier').allowanceUsd).toBeLessThanOrEqual(mostConservative);
    expect(budgetFor(null).allowanceUsd).toBeLessThanOrEqual(mostConservative);
  });
});

describe('evaluateBudget', () => {
  const budget = { allowanceUsd: 10, hardCapUsd: 30 };

  it('reports ok well under the allowance', () => {
    expect(evaluateBudget(1, budget)).toBe('ok');
  });

  it(`reports soft_exceeded at exactly ${SOFT_THRESHOLD_MULTIPLE}x the allowance`, () => {
    expect(evaluateBudget(budget.allowanceUsd * SOFT_THRESHOLD_MULTIPLE, budget)).toBe('soft_exceeded');
  });

  it('reports soft_exceeded, not hard_exceeded, between the soft threshold and the hard cap', () => {
    expect(evaluateBudget(20, budget)).toBe('soft_exceeded');
  });

  it('reports hard_exceeded at or above the hard cap', () => {
    expect(evaluateBudget(30, budget)).toBe('hard_exceeded');
    expect(evaluateBudget(31, budget)).toBe('hard_exceeded');
  });
});
