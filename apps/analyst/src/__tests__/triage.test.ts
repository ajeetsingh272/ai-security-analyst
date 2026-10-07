/**
 * P4-05 T4 and the triage/caching logic that doesn't need a real
 * Anthropic call: parsing, the fail-safe-to-escalate behaviour, and the
 * cache-hit bookkeeping (real network/cache behaviour is faked here —
 * same boundary as every other ticket in this sandbox, no real
 * ANTHROPIC_API_KEY configured; the REAL cache mechanics are exercised
 * against a real Anthropic response shape, just not a real network call).
 */
import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicTriageModel, parseTriageDecision, tenantContextBlock } from '../triage.js';

function triageResponse(text: string, cacheReadTokens: number): Anthropic.Message {
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: cacheReadTokens, cache_creation_input_tokens: 0 } as never,
  } as unknown as Anthropic.Message;
}

describe('parseTriageDecision', () => {
  it('parses a well-formed dismiss decision', () => {
    expect(parseTriageDecision('{"decision":"dismiss","reason":"benign"}')).toEqual({ decision: 'dismiss', reason: 'benign' });
  });

  it('parses a well-formed escalate decision', () => {
    expect(parseTriageDecision('{"decision":"escalate","reason":"suspicious"}')).toEqual({ decision: 'escalate', reason: 'suspicious' });
  });

  it('fails safe to escalate on invalid JSON, never dismisses on a parse failure', () => {
    const result = parseTriageDecision('not json');
    expect(result.decision).toBe('escalate');
  });

  it('fails safe to escalate on an unrecognised decision value', () => {
    const result = parseTriageDecision('{"decision":"maybe","reason":"unsure"}');
    expect(result.decision).toBe('escalate');
  });
});

describe('tenantContextBlock', () => {
  it('is a pure function of tenantId alone — identical input, identical output (required for cache reuse)', () => {
    expect(tenantContextBlock('tenant-a')).toBe(tenantContextBlock('tenant-a'));
    expect(tenantContextBlock('tenant-a')).not.toBe(tenantContextBlock('tenant-b'));
  });
});

describe('AnthropicTriageModel', () => {
  it('T4: the model identifier comes from configuration, not a hardcoded literal', async () => {
    const create = vi.fn().mockResolvedValue(triageResponse('{"decision":"dismiss","reason":"ok"}', 0));
    const fakeClient = { messages: { create } } as unknown as Anthropic;
    const model = new AnthropicTriageModel({ apiKey: 'unused', model: 'a-totally-configurable-model-id', client: fakeClient });

    await model.triage({ caseId: 'c1', tenantId: 't1', windowStart: '2026-01-01T00:00:00.000Z', windowEnd: null });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'a-totally-configurable-model-id' }));
  });

  it('T3 (bookkeeping): a cache miss on the first call and a hit on the second is recorded correctly', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(triageResponse('{"decision":"escalate","reason":"first"}', 0))
      .mockResolvedValueOnce(triageResponse('{"decision":"escalate","reason":"second"}', 500));
    const fakeClient = { messages: { create } } as unknown as Anthropic;
    const calls = { add: vi.fn() };
    const hits = { add: vi.fn() };
    const model = new AnthropicTriageModel({ apiKey: 'unused', model: 'test-model', client: fakeClient, cacheMetrics: { calls: calls as never, hits: hits as never } });

    await model.triage({ caseId: 'c1', tenantId: 't1', windowStart: '2026-01-01T00:00:00.000Z', windowEnd: null });
    await model.triage({ caseId: 'c2', tenantId: 't1', windowStart: '2026-01-01T00:00:00.000Z', windowEnd: null });

    expect(calls.add).toHaveBeenCalledTimes(2);
    expect(hits.add).toHaveBeenCalledTimes(1); // only the second call was a cache hit
  });

  it('includes the tenant context block with cache_control in the system prompt', async () => {
    const create = vi.fn().mockResolvedValue(triageResponse('{"decision":"dismiss","reason":"ok"}', 0));
    const fakeClient = { messages: { create } } as unknown as Anthropic;
    const model = new AnthropicTriageModel({ apiKey: 'unused', model: 'test-model', client: fakeClient });

    await model.triage({ caseId: 'c1', tenantId: 'tenant-xyz', windowStart: '2026-01-01T00:00:00.000Z', windowEnd: null });

    const callArgs = create.mock.calls[0]![0] as { system: Array<{ text: string; cache_control?: unknown }> };
    const cachedBlock = callArgs.system.find((b) => b.cache_control !== undefined);
    expect(cachedBlock?.text).toContain('tenant-xyz');
  });
});
