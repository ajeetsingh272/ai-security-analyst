/**
 * P4-06 AC2: "cost is computed from a configurable price table, not
 * hardcoded rates." Prices live in `config/model-prices.json`, not
 * scattered numeric literals in this file's own logic — an operator
 * updates cost by editing that data file, never by touching
 * `computeCostUsd`'s own code. Units are USD per MILLION tokens,
 * matching how providers publish their own pricing, so an entry can be
 * copied straight off a pricing page without unit conversion.
 */
import { readFileSync } from 'node:fs';

export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheWritePerMillion: number;
  cacheReadPerMillion: number;
}

export type PriceTable = Record<string, ModelPrice>;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export function loadPriceTable(path: string): PriceTable {
  return JSON.parse(readFileSync(path, 'utf8')) as PriceTable;
}

export class UnknownModelPriceError extends Error {
  constructor(model: string) {
    super(`no price entry configured for model "${model}" — refusing to guess a cost`);
    this.name = 'UnknownModelPriceError';
  }
}

/**
 * T4: correct for a mixed cached/uncached workload — each of the four
 * token kinds (input, output, cache read, cache write/creation) has
 * its OWN per-million rate, since a cache read is dramatically cheaper
 * than a fresh input token. Conflating them would make caching's own
 * cost savings (P4-05) invisible in the number that matters most: the
 * actual bill.
 */
/** T1: "token accounting matches the provider's reported usage" —
 * this is the ONE place an Anthropic response's own usage shape
 * (nullable cache fields; Anthropic omits them entirely on a response
 * with no caching involved) is translated into this file's own
 * `Usage`, so every caller sees the same non-nullable shape regardless
 * of which call produced it. */
export function usageFromAnthropic(usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): Usage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

export function computeCostUsd(usage: Usage, model: string, priceTable: PriceTable): number {
  const price = priceTable[model];
  if (!price) throw new UnknownModelPriceError(model);
  return (
    (usage.inputTokens / 1_000_000) * price.inputPerMillion +
    (usage.outputTokens / 1_000_000) * price.outputPerMillion +
    (usage.cacheReadTokens / 1_000_000) * price.cacheReadPerMillion +
    (usage.cacheCreationTokens / 1_000_000) * price.cacheWritePerMillion
  );
}
