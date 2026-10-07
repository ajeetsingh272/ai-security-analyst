/**
 * P4-02 unit tests: the generic tool wrapper (runTool/withTimeout/
 * truncate, tools/types.ts) and entity-baseline.ts's pure `evaluate` —
 * none of this touches a real ClickHouse or Postgres, mirroring
 * services/correlate/internal/baseline/baseline.go's own T1/T2 split
 * between pure evaluation (tested with no database at all) and the
 * ClickHouse-aware shell (tested in tools.integration.test.ts instead).
 */
import { describe, expect, it, vi } from 'vitest';
import { runTool, truncate, withTimeout, ToolTimeoutError, ToolInvalidArgumentError, isToolError } from '../tools/types.js';
import { evaluate, MIN_OBSERVATIONS } from '../tools/entity-baseline.js';

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
}

describe('truncate', () => {
  it('returns every item untruncated when within the limit', () => {
    const { items, truncated } = truncate([1, 2, 3], 5);
    expect(items).toEqual([1, 2, 3]);
    expect(truncated).toBe(false);
  });

  it('AC3: truncates with an explicit marker rather than silently cutting', () => {
    const { items, truncated } = truncate([1, 2, 3, 4, 5], 3);
    expect(items).toEqual([1, 2, 3]);
    expect(truncated).toBe(true);
  });
});

describe('withTimeout', () => {
  it('resolves with the value when the function finishes first', async () => {
    const result = await withTimeout(async () => 'done', 1000, 'test_tool');
    expect(result).toBe('done');
  });

  it('AC4 (T4): rejects with ToolTimeoutError when the timeout wins, and calls onTimeout', async () => {
    const onTimeout = vi.fn();
    const neverResolves = () => new Promise<string>(() => {});
    await expect(withTimeout(neverResolves, 20, 'slow_tool', onTimeout)).rejects.toThrow(ToolTimeoutError);
    expect(onTimeout).toHaveBeenCalledOnce();
  });
});

describe('runTool', () => {
  it('returns the value on success and logs the call', async () => {
    const logger = fakeLogger();
    const result = await runTool({
      name: 'query_events',
      tenantId: 'tenant-a',
      args: { entityId: 'e1' },
      timeoutMs: 1000,
      logger,
      fn: async () => ({ ok: true }),
    });
    expect(result).toEqual({ ok: true });
    expect((logger as { info: ReturnType<typeof vi.fn> }).info).toHaveBeenCalledOnce();
  });

  it('T4: a timeout returns a structured error the caller can act on, never throws', async () => {
    const logger = fakeLogger();
    const result = await runTool({
      name: 'slow_tool',
      tenantId: 'tenant-a',
      args: {},
      timeoutMs: 20,
      logger,
      fn: () => new Promise(() => {}),
    });
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.code).toBe('timeout');
    }
    expect((logger as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledOnce();
  });

  it('a thrown ToolInvalidArgumentError becomes a structured invalid_argument error', async () => {
    const logger = fakeLogger();
    const result = await runTool({
      name: 'query_events',
      tenantId: 'tenant-a',
      args: {},
      timeoutMs: 1000,
      logger,
      fn: async () => {
        throw new ToolInvalidArgumentError('entityId is required');
      },
    });
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.code).toBe('invalid_argument');
      expect(result.message).toContain('entityId is required');
    }
  });

  it('an unexpected thrown error becomes a structured internal_error, never propagates', async () => {
    const logger = fakeLogger();
    const result = await runTool({
      name: 'query_events',
      tenantId: 'tenant-a',
      args: {},
      timeoutMs: 1000,
      logger,
      fn: async () => {
        throw new Error('connection refused');
      },
    });
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.code).toBe('internal_error');
      expect(result.message).toContain('connection refused');
    }
  });
});

describe('entity-baseline evaluate (ported from baseline.go)', () => {
  it('a habitual categorical value is reported with Valid=true once observations meet the floor', () => {
    const b = evaluate('country', { observations: MIN_OBSERVATIONS, topValues: ['IN', 'US'], quantiles: [] });
    expect(b.valid).toBe(true);
    expect(b.usualValues).toEqual(['IN', 'US']);
  });

  it('an under-threshold entity reports insufficient data (Valid=false), never a guess', () => {
    const b = evaluate('country', { observations: MIN_OBSERVATIONS - 1, topValues: ['IN'], quantiles: [] });
    expect(b.valid).toBe(false);
    expect(b.usualValues).toEqual([]);
  });

  it('data_volume reports p50/p95/p99 instead of usual values', () => {
    const b = evaluate('data_volume', { observations: 50, topValues: [], quantiles: [100, 500, 900] });
    expect(b.valid).toBe(true);
    expect(b.volume).toEqual({ p50: 100, p95: 500, p99: 900 });
    expect(b.usualValues).toEqual([]);
  });
});
