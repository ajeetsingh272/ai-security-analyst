/**
 * P4-02: the Anthropic tool-use loop added to AnthropicInvestigationModel.
 * A fake Anthropic client stands in for the network call — the same
 * testing boundary P4-01 already established (no real ANTHROPIC_API_KEY
 * in this sandbox) — exercised with `lookup_threat_intel` specifically
 * because it is the one tool that needs no real ClickHouse/Postgres
 * dependency at all, so this file proves the LOOP itself (does it feed
 * tool_use back as tool_result, does it stop, does it bound iterations)
 * with zero real infra, leaving the four tools' own correctness to
 * tools.test.ts/tools.integration.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicInvestigationModel, UnparsableVerdictError } from '../investigation-model.js';
import type { ToolDependencies } from '../tools/index.js';

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
}

const CANNED_VERDICT_TEXT = JSON.stringify({
  severity: 'high',
  title: 'Investigated via tool use',
  claims: [{ text: 'claim', evidenceRef: ['evt_1'] }],
  attackChain: ['T1078'],
  recommendedActions: [{ playbook: 'revoke_sessions', urgency: 'now', blastRadius: 'single_user' }],
});

function toolUseResponse(id: string, name: string, input: unknown): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'tool_use', id, name, input }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 } as never,
  } as unknown as Anthropic.Message;
}

function finalTextResponse(text: string): Anthropic.Message {
  return {
    id: 'msg_2',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 } as never,
  } as unknown as Anthropic.Message;
}

function fakeDeps(): ToolDependencies {
  return { ch: null as never, pool: null as never, logger: fakeLogger() };
}

describe('AnthropicInvestigationModel tool-use loop', () => {
  it('executes a requested tool, feeds the result back, and returns the final verdict', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(toolUseResponse('tool_1', 'lookup_threat_intel', { indicator: '1.2.3.4', indicatorType: 'ip' }))
      .mockResolvedValueOnce(finalTextResponse(CANNED_VERDICT_TEXT));
    const fakeClient = { messages: { create } } as unknown as Anthropic;

    const model = new AnthropicInvestigationModel({
      apiKey: 'unused',
      model: 'test-model',
      client: fakeClient,
      tools: fakeDeps(),
    });

    const verdict = await model.investigate({ caseId: 'case-1', tenantId: 'tenant-1' });

    expect(verdict.title).toBe('Investigated via tool use');
    expect(create).toHaveBeenCalledTimes(2);

    const secondCallArgs = create.mock.calls[1]![0] as { messages: Anthropic.MessageParam[] };
    const toolResultMessage = secondCallArgs.messages.at(-1)!;
    expect(toolResultMessage.role).toBe('user');
    const toolResultBlock = (toolResultMessage.content as Array<{ type: string; tool_use_id?: string; content?: string }>)[0]!;
    expect(toolResultBlock.type).toBe('tool_result');
    expect(toolResultBlock.tool_use_id).toBe('tool_1');
    expect(toolResultBlock.content).toContain('"configured":false');
  });

  it('never calls a tool when no ToolDependencies were provided, even if asked', async () => {
    const create = vi.fn().mockResolvedValueOnce(finalTextResponse(CANNED_VERDICT_TEXT));
    const fakeClient = { messages: { create } } as unknown as Anthropic;

    const model = new AnthropicInvestigationModel({ apiKey: 'unused', model: 'test-model', client: fakeClient });
    const verdict = await model.investigate({ caseId: 'case-1', tenantId: 'tenant-1' });

    expect(verdict.title).toBe('Investigated via tool use');
    expect(create).toHaveBeenCalledTimes(1);
    const callArgs = create.mock.calls[0]![0] as { tools?: unknown };
    expect(callArgs.tools).toBeUndefined();
  });

  it('T2: a malformed verdict triggers exactly one repair attempt, then succeeds', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(finalTextResponse('not valid json at all'))
      .mockResolvedValueOnce(finalTextResponse(CANNED_VERDICT_TEXT));
    const fakeClient = { messages: { create } } as unknown as Anthropic;

    const model = new AnthropicInvestigationModel({ apiKey: 'unused', model: 'test-model', client: fakeClient });
    const verdict = await model.investigate({ caseId: 'case-1', tenantId: 'tenant-1' });

    expect(verdict.title).toBe('Investigated via tool use');
    expect(create).toHaveBeenCalledTimes(2);
    const secondCallArgs = create.mock.calls[1]![0] as { messages: Anthropic.MessageParam[] };
    const repairPrompt = secondCallArgs.messages.at(-1)!;
    expect(repairPrompt.role).toBe('user');
    expect(String(repairPrompt.content)).toContain('could not be used');
  });

  it('T2: a SECOND consecutive malformed verdict fails the investigation rather than repairing again', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(finalTextResponse('not valid json at all'))
      .mockResolvedValueOnce(finalTextResponse('still not valid json'));
    const fakeClient = { messages: { create } } as unknown as Anthropic;

    const model = new AnthropicInvestigationModel({ apiKey: 'unused', model: 'test-model', client: fakeClient });

    await expect(model.investigate({ caseId: 'case-1', tenantId: 'tenant-1' })).rejects.toThrow(UnparsableVerdictError);
    // Exactly one repair attempt: the call that would be a SECOND
    // repair never happens.
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('T3 (via the loop): an unknown playbook is treated as a schema violation and triggers the repair path', async () => {
    const badPlaybookVerdict = JSON.stringify({
      severity: 'high',
      title: 'Bad action',
      claims: [{ text: 'x', evidenceRef: ['evt_1'] }],
      attackChain: [],
      recommendedActions: [{ playbook: 'launch_the_nukes', urgency: 'now', blastRadius: 'none' }],
    });
    const create = vi
      .fn()
      .mockResolvedValueOnce(finalTextResponse(badPlaybookVerdict))
      .mockResolvedValueOnce(finalTextResponse(CANNED_VERDICT_TEXT));
    const fakeClient = { messages: { create } } as unknown as Anthropic;

    const model = new AnthropicInvestigationModel({ apiKey: 'unused', model: 'test-model', client: fakeClient });
    const verdict = await model.investigate({ caseId: 'case-1', tenantId: 'tenant-1' });

    expect(verdict.title).toBe('Investigated via tool use');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('bounds the loop: gives up with UnparsableVerdictError rather than looping forever', async () => {
    const create = vi.fn().mockResolvedValue(toolUseResponse('tool_x', 'lookup_threat_intel', { indicator: 'x', indicatorType: 'ip' }));
    const fakeClient = { messages: { create } } as unknown as Anthropic;

    const model = new AnthropicInvestigationModel({ apiKey: 'unused', model: 'test-model', client: fakeClient, tools: fakeDeps() });

    await expect(model.investigate({ caseId: 'case-1', tenantId: 'tenant-1' })).rejects.toThrow(UnparsableVerdictError);
    expect(create).toHaveBeenCalledTimes(6);
  });
});
