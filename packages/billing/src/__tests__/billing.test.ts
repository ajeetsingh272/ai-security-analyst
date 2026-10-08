import { describe, expect, it } from 'vitest';
import { PLAN_LIMITS, PLAN_PRICING, evaluateLimit, worstStatus, computeMargin, limitsFor, pricingFor } from '../index.js';

describe('evaluateLimit', () => {
  const band = { allowance: 10, hardCap: 20 };

  it('is "ok" below the soft threshold', () => {
    expect(evaluateLimit(14, band)).toBe('ok');
  });

  it('is "soft_exceeded" at exactly 1.5x the allowance', () => {
    expect(evaluateLimit(15, band)).toBe('soft_exceeded');
  });

  it('is "hard_exceeded" at exactly the hard cap', () => {
    expect(evaluateLimit(20, band)).toBe('hard_exceeded');
  });

  it('stays "hard_exceeded" well past the hard cap, not something worse', () => {
    expect(evaluateLimit(1000, band)).toBe('hard_exceeded');
  });
});

describe('worstStatus', () => {
  it('returns the most severe of several axes', () => {
    expect(worstStatus('ok', 'ok', 'ok')).toBe('ok');
    expect(worstStatus('ok', 'soft_exceeded', 'ok')).toBe('soft_exceeded');
    expect(worstStatus('soft_exceeded', 'hard_exceeded', 'ok')).toBe('hard_exceeded');
  });

  it('is "ok" for zero axes', () => {
    expect(worstStatus()).toBe('ok');
  });
});

describe('limitsFor / pricingFor', () => {
  it('falls back to the most conservative limits and to trial pricing for an unrecognised plan', () => {
    expect(limitsFor('not_a_real_plan')).toEqual(limitsFor('trial'));
    expect(pricingFor('not_a_real_plan')).toEqual(PLAN_PRICING.trial);
  });

  it('every real plan tier has a seats, event-volume, and cost band, each with hardCap above allowance', () => {
    for (const tier of Object.keys(PLAN_LIMITS) as Array<keyof typeof PLAN_LIMITS>) {
      const limits = PLAN_LIMITS[tier];
      expect(limits.seats.hardCap).toBeGreaterThan(limits.seats.allowance);
      expect(limits.eventVolumePerDay.hardCap).toBeGreaterThan(limits.eventVolumePerDay.allowance);
      expect(limits.costUsdPerDay.hardCap).toBeGreaterThan(limits.costUsdPerDay.allowance);
    }
  });
});

describe('computeMargin', () => {
  it('T3: margin is revenue minus COGS, for each real plan tier', () => {
    expect(computeMargin('msp', 300)).toEqual({ revenueUsd: 1500, cogsUsd: 300, marginUsd: 1200, marginPct: 80 });
    expect(computeMargin('small_business', 100)).toEqual({ revenueUsd: 400, cogsUsd: 100, marginUsd: 300, marginPct: 75 });
    expect(computeMargin('startup', 50)).toEqual({ revenueUsd: 200, cogsUsd: 50, marginUsd: 150, marginPct: 75 });
  });

  it('T3: a tenant costing more than its plan brings in has a negative margin, honestly reported, not clamped to zero', () => {
    const margin = computeMargin('startup', 500);
    expect(margin.marginUsd).toBe(-300);
    expect(margin.marginPct).toBe(-150);
  });

  it("T3: a $0-revenue tier (trial) reports marginPct as null, not a divide-by-zero artifact", () => {
    const margin = computeMargin('trial', 4);
    expect(margin.revenueUsd).toBe(0);
    expect(margin.marginUsd).toBe(-4);
    expect(margin.marginPct).toBeNull();
  });

  it('an unrecognised plan is treated as trial pricing (most conservative, not invented revenue)', () => {
    expect(computeMargin('enterprise_deluxe', 10)).toEqual(computeMargin('trial', 10));
  });
});
