/**
 * The investigation step (P4-01's own minimal slice of ADR-0006's
 * tiered design) — calls Claude, lets it call P4-02's own investigation
 * tools, and parses its final response into a Verdict (packages/schema's
 * own frozen contract, P3-08/P0-11).
 *
 * Deliberately NOT the full ADR-0006 design: tiered routing between
 * Haiku (triage) and Opus (investigation), and prompt caching, are
 * P4-05's own ticket; the structured-output contract's real parsing
 * and validation (claims with evidence_ref, grounding) are P4-03's
 * and P4-04's. This file's job is to prove the worker SKELETON (P4-01)
 * produces *a* Verdict end to end, now WITH the real tool-use loop
 * (P4-02) that lets the model actually gather evidence rather than
 * guess — a minimal prompt, no caching, no tiering yet.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Verdict } from '@sentinel/schema';
import { TOOL_DEFINITIONS, executeTool, type ToolDependencies } from './tools/index.js';

export interface CaseContext {
  caseId: string;
  tenantId: string;
  severity?: string;
  title?: string;
  score?: number;
}

export interface InvestigationModel {
  investigate(ctx: CaseContext): Promise<Verdict>;
}

/** Thrown when the model's response cannot be parsed into a Verdict
 * at all — P4-03's own job to make this richer (retry-with-the-
 * -validation-error-fed-back, per ADR-0006); P4-01 only needs this
 * to exist as a distinguishable failure mode its own retry logic
 * can reason about (a malformed response is not a transient
 * provider error — retrying the IDENTICAL request would get the
 * identical malformed response). */
export class UnparsableVerdictError extends Error {
  constructor(
    message: string,
    readonly rawResponse: string,
  ) {
    super(message);
    this.name = 'UnparsableVerdictError';
  }
}

const SYSTEM_PROMPT = `You are a security analyst investigating an escalated case. You may call the available tools to gather evidence before answering. When you are done, respond with ONLY a JSON object matching this exact shape, no other text:
{"severity": "critical"|"high"|"medium"|"low"|"info", "title": string, "claims": [{"text": string, "evidenceRef": string[]}], "attackChain": string[], "recommendedActions": [{"playbook": string, "urgency": "now"|"today"|"later", "blastRadius": string}]}`;

export interface AnthropicInvestigationModelOptions {
  apiKey: string;
  model: string;
  maxTokens?: number;
  client?: Anthropic;
  /** P4-02's query_events/get_entity_baseline/lookup_threat_intel/
   * get_case_history tools. Omitted entirely (not just empty) means the
   * model is given no `tools` at all in the API call — kept optional so
   * a caller that hasn't wired a ClickHouse client/pool yet (there is
   * none in this sandbox without real infra) still compiles and runs. */
  tools?: ToolDependencies;
}

/** AC: a case this far into tool use without a final answer is itself an
 * anomaly worth stopping on rather than letting run unbounded — bounds
 * worst-case Anthropic spend and worker time per case the same way
 * retry.ts's own maxAttempts bounds retry spend. */
const MAX_TOOL_ITERATIONS = 6;

export class AnthropicInvestigationModel implements InvestigationModel {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly tools: ToolDependencies | undefined;

  constructor(opts: AnthropicInvestigationModelOptions) {
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? 8192;
    this.tools = opts.tools;
  }

  async investigate(ctx: CaseContext): Promise<Verdict> {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: `Case ${ctx.caseId} (tenant ${ctx.tenantId}): severity=${ctx.severity ?? 'unknown'}, title=${ctx.title ?? 'untitled'}, score=${ctx.score ?? 'unknown'}.`,
      },
    ];

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: SYSTEM_PROMPT,
        messages,
        ...(this.tools ? { tools: TOOL_DEFINITIONS } : {}),
      });

      if (response.stop_reason !== 'tool_use' || !this.tools) {
        const block = response.content.find((b) => b.type === 'text');
        const text = block && block.type === 'text' ? block.text : '';
        return parseVerdict(text);
      }

      messages.push({ role: 'assistant', content: response.content });
      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        const result = await executeTool(block.name, ctx.tenantId, block.input, this.tools);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    throw new UnparsableVerdictError(`model did not produce a final answer within ${MAX_TOOL_ITERATIONS} tool-use iterations`, '');
  }
}

/** Exported for P4-03 to build on, and for this ticket's own unit
 * tests — parsing is pure and has nothing to do with the network
 * call itself. */
export function parseVerdict(text: string): Verdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new UnparsableVerdictError(`model response was not valid JSON: ${(err as Error).message}`, text);
  }
  if (!isVerdictShaped(parsed)) {
    throw new UnparsableVerdictError('model response was valid JSON but not a Verdict', text);
  }
  return parsed;
}

function isVerdictShaped(value: unknown): value is Verdict {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.severity === 'string' &&
    typeof v.title === 'string' &&
    Array.isArray(v.claims) &&
    Array.isArray(v.attackChain) &&
    Array.isArray(v.recommendedActions)
  );
}
