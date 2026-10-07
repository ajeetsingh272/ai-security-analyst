/**
 * P4-06 T1/T4 — token accounting and cost calculation, pure functions,
 * no network, no database.
 */
import { describe, expect, it } from 'vitest';
import { computeCostUsd, usageFromAnthropic, UnknownModelPriceError, type PriceTable } from '../pricing.js';

const PRICES: PriceTable = {
  'test-model': { inputPerMillion: 10, outputPerMillion: 20, cacheWritePerMillion: 12, cacheReadPerMillion: 1 },
};

describe('usageFromAnthropic', () => {
  it('T1: token accounting matches the provider\'s reported usage exactly', () => {
    expect(usageFromAnthropic({ input_tokens: 123, output_tokens: 45, cache_read_input_tokens: 67, cache_creation_input_tokens: 8 })).toEqual({
      inputTokens: 123,
      outputTokens: 45,
      cacheReadTokens: 67,
      cacheCreationTokens: 8,
    });
  });

  it('defaults absent cache fields to 0 rather than undefined/null', () => {
    expect(usageFromAnthropic({ input_tokens: 10, output_tokens: 5 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});

describe('computeCostUsd', () => {
  it('T4: correctly prices a mixed cached and uncached workload', () => {
    // 1,000,000 of each kind at the PRICES above: $10 + $20 + $1 (cache
    // read) + $12 (cache write) = $43.
    const cost = computeCostUsd(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000 },
      'test-model',
      PRICES,
    );
    expect(cost).toBeCloseTo(43, 6);
  });

  it('a cache read is dramatically cheaper than a fresh input token in the same calculation', () => {
    const allFreshInput = computeCostUsd({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, 'test-model', PRICES);
    const allCacheRead = computeCostUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreationTokens: 0 }, 'test-model', PRICES);
    expect(allCacheRead).toBeLessThan(allFreshInput);
  });

  it('throws UnknownModelPriceError for a model with no configured price, rather than silently costing $0', () => {
    expect(() => computeCostUsd({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }, 'no-such-model', PRICES)).toThrow(
      UnknownModelPriceError,
    );
  });

  it('zero usage costs exactly $0', () => {
    expect(computeCostUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, 'test-model', PRICES)).toBe(0);
  });
});
