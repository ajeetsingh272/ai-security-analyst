/**
 * P4-11 T2 (the pure half): replay never calls a tool at all — there
 * is no code path in replay.ts that even checks `stop_reason ===
 * 'tool_use'`, so it structurally cannot execute one. Proven here
 * with a fake Anthropic client; the end-to-end capture-then-replay
 * loop (T1) is in replay-transcript.integration.test.ts, against real
 * Postgres.
 */
import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { replayInvestigation } from '../replay.js';
import type { Transcript } from '../transcript.js';

function finalTextResponse(text: string): Anthropic.Message {
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 } as never,
  } as unknown as Anthropic.Message;
}

const VERDICT_TEXT = JSON.stringify({
  severity: 'high',
  title: 'Replayed verdict',
  claims: [{ text: 'claim', evidenceRef: ['evt_1'] }],
  attackChain: [],
  recommendedActions: [],
});

const TRANSCRIPT: Transcript = {
  model: 'original-model',
  system: [{ type: 'text', text: 'system prompt' }],
  messages: [
    { role: 'user', content: 'case summary' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'query_events', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'captured tool result, never re-fetched' }] },
  ],
  finalResponseContent: [{ type: 'text', text: VERDICT_TEXT, citations: null }],
  verdict: JSON.parse(VERDICT_TEXT),
};

describe('replayInvestigation', () => {
  it('AC2: replays against a DIFFERENT model than the one originally used', async () => {
    const create = vi.fn().mockResolvedValue(finalTextResponse(VERDICT_TEXT));
    const client = { messages: { create } } as unknown as Anthropic;

    await replayInvestigation(TRANSCRIPT, { apiKey: 'unused', model: 'a-different-model', client });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'a-different-model' }));
  });

  it('T2: replay never attempts a tool call, even though the captured transcript contains one', async () => {
    const create = vi.fn().mockResolvedValue(finalTextResponse(VERDICT_TEXT));
    const client = { messages: { create } } as unknown as Anthropic;

    await replayInvestigation(TRANSCRIPT, { apiKey: 'unused', model: 'a-different-model', client });

    // Exactly one call: replay never loops to handle a tool_use
    // response, because it never asks the model to use tools at all
    // (no `tools` field is ever sent).
    expect(create).toHaveBeenCalledTimes(1);
    const callArgs = create.mock.calls[0]![0] as { tools?: unknown; messages: unknown };
    expect(callArgs.tools).toBeUndefined();
    // The captured tool_use/tool_result turns are replayed VERBATIM —
    // never re-executed.
    expect(callArgs.messages).toEqual(TRANSCRIPT.messages);
  });

  it('produces a parsed Verdict from the replay response', async () => {
    const create = vi.fn().mockResolvedValue(finalTextResponse(VERDICT_TEXT));
    const client = { messages: { create } } as unknown as Anthropic;

    const verdict = await replayInvestigation(TRANSCRIPT, { apiKey: 'unused', model: 'a-different-model', client });
    expect(verdict.title).toBe('Replayed verdict');
  });
});
