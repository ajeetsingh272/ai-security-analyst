/**
 * P4-11 T3: captured prompts are redacted of credentials BEFORE
 * storage. @sentinel/observability's own `redact` already has its
 * own dedicated test suite proving WHAT it redacts — this file proves
 * only that `PostgresTranscriptRecorder` actually calls it, and calls
 * it before anything reaches the repository, not after.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const recordMock = vi.fn().mockResolvedValue('transcript-id');
vi.mock('@sentinel/db', () => ({
  withTenantContext: (_tenantId: string, fn: () => unknown) => fn(),
  InvestigationTranscriptRepository: vi.fn().mockImplementation(() => ({ record: recordMock })),
}));

const { PostgresTranscriptRecorder } = await import('../transcript.js');
const { redact } = await import('@sentinel/observability');

beforeEach(() => {
  recordMock.mockClear();
});

describe('PostgresTranscriptRecorder', () => {
  it('T3: redacts the transcript before it ever reaches the repository', async () => {
    const recorder = new PostgresTranscriptRecorder({} as never);
    const secretBearingTranscript = {
      model: 'test-model',
      system: [{ type: 'text' as const, text: 'system prompt' }],
      messages: [{ role: 'user' as const, content: 'password: hunter2hunter2 is in this log line' }],
      finalResponseContent: [{ type: 'text' as const, text: '{}', citations: null }],
      verdict: { severity: 'low' as const, title: 'x', claims: [], attackChain: [], recommendedActions: [] },
    };

    await recorder.record('tenant-1', 'case-1', secretBearingTranscript);

    expect(recordMock).toHaveBeenCalledOnce();
    const storedInput = recordMock.mock.calls[0]![1] as { messages: unknown };
    expect(JSON.stringify(storedInput.messages)).not.toContain('hunter2hunter2');
    expect(JSON.stringify(storedInput.messages)).toContain('REDACTED');
  });

  it('matches what @sentinel/observability\'s own redact would produce, rather than a second redaction implementation', async () => {
    const recorder = new PostgresTranscriptRecorder({} as never);
    const transcript = {
      model: 'test-model',
      system: [{ type: 'text' as const, text: 'system' }],
      messages: [{ role: 'user' as const, content: 'api_key=sk-abc123' }],
      finalResponseContent: [{ type: 'text' as const, text: '{}', citations: null }],
      verdict: { severity: 'low' as const, title: 'x', claims: [], attackChain: [], recommendedActions: [] },
    };

    await recorder.record('tenant-1', 'case-1', transcript);

    const storedInput = recordMock.mock.calls[0]![1] as { messages: unknown; system: unknown; finalResponse: unknown; verdict: unknown };
    expect(storedInput.messages).toEqual((redact(transcript) as typeof transcript).messages);
  });
});
