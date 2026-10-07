/**
 * P4-11 AC1/AC3: full prompt/tool-call/response capture for a real
 * investigation, redacted before storage via
 * @sentinel/observability's own `redact` — the SAME function the
 * logger already wires into every log call (P0-10 AC3), not a second
 * redaction mechanism invented here that could drift from what every
 * other part of this codebase already trusts.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { Pool } from 'pg';
import type { Verdict } from '@sentinel/schema';
import { withTenantContext, InvestigationTranscriptRepository } from '@sentinel/db';
import { redact } from '@sentinel/observability';

export interface Transcript {
  model: string;
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  finalResponseContent: Anthropic.ContentBlock[];
  verdict: Verdict;
}

export interface TranscriptRecorder {
  record(tenantId: string, caseId: string, transcript: Transcript): Promise<void>;
}

export class PostgresTranscriptRecorder implements TranscriptRecorder {
  constructor(private readonly pool: Pool) {}

  async record(tenantId: string, caseId: string, transcript: Transcript): Promise<void> {
    // T3: redacted BEFORE it ever reaches the repository/SQL layer —
    // this table is not itself a place secrets could leak from, by
    // construction, not by a column-level policy a future query could
    // bypass.
    const redacted = redact(transcript) as Transcript;
    await withTenantContext(tenantId, () =>
      new InvestigationTranscriptRepository(this.pool).record(caseId, {
        model: redacted.model,
        system: redacted.system,
        messages: redacted.messages,
        finalResponse: redacted.finalResponseContent,
        verdict: redacted.verdict,
      }),
    );
  }
}
