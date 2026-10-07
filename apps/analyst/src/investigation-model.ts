/**
 * The investigation step (P4-01's own minimal slice of ADR-0006's
 * tiered design) — calls Claude, lets it call P4-02's own investigation
 * tools, validates its final response against the Verdict contract
 * (packages/schema's own frozen shape, P3-08/P0-11), and gives the model
 * exactly one chance to correct itself if that validation fails (P4-03).
 *
 * Deliberately NOT the full ADR-0006 design: tiered routing between
 * Haiku (triage) and Opus (investigation), and prompt caching, are
 * P4-05's own ticket; grounding each claim's evidenceRef against the
 * real event store is P4-04's. This file's job is to prove the worker
 * produces a real, schema-valid Verdict end to end — gathering evidence
 * via tools (P4-02) and self-correcting a malformed first answer (P4-03)
 * — a minimal prompt, no caching, no tiering yet.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Verdict } from '@sentinel/schema';
import { TOOL_DEFINITIONS, executeTool, type ToolDependencies } from './tools/index.js';
import { validateVerdict, formatValidationErrors } from './verdict-validation.js';
import { PLAYBOOK_REGISTRY } from './playbook-registry.js';

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

/** Thrown when the model's response cannot be turned into a valid
 * Verdict even after the one repair attempt AC3 allows — a
 * distinguishable failure mode `main.ts`'s own `isRetryable` already
 * treats as non-retryable (a malformed response is not a transient
 * provider error — retrying the IDENTICAL request gets the identical
 * malformed response; only a DIFFERENT request, i.e. the repair
 * attempt this file already tried once, has any chance of succeeding). */
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
{"severity": "critical"|"high"|"medium"|"low"|"info", "title": string, "claims": [{"text": string, "evidenceRef": string[] (non-empty, every claim must cite at least one piece of evidence)}], "attackChain": string[], "recommendedActions": [{"playbook": one of [${PLAYBOOK_REGISTRY.join(', ')}], "urgency": "now"|"today"|"later", "blastRadius": string}]}`;

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
    // AC3: "a schema violation triggers one repair attempt, then fails
    // the investigation" — exactly one chance across the WHOLE
    // investigation, not one per malformed response, so this is a
    // single flag, not a counter with a higher budget.
    let repairAttempted = false;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: SYSTEM_PROMPT,
        messages,
        ...(this.tools ? { tools: TOOL_DEFINITIONS } : {}),
      });

      if (response.stop_reason === 'tool_use' && this.tools) {
        messages.push({ role: 'assistant', content: response.content });
        const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of toolUseBlocks) {
          const result = await executeTool(block.name, ctx.tenantId, block.input, this.tools);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
        }
        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      const block = response.content.find((b) => b.type === 'text');
      const text = block && block.type === 'text' ? block.text : '';
      try {
        return parseVerdict(text);
      } catch (err) {
        if (!(err instanceof UnparsableVerdictError) || repairAttempted) throw err;
        repairAttempted = true;
        messages.push({ role: 'assistant', content: response.content });
        messages.push({
          role: 'user',
          content: `Your previous response could not be used: ${err.message}. Respond again with ONLY a corrected JSON object matching the required shape — no other text.`,
        });
      }
    }

    throw new UnparsableVerdictError(`model did not produce a valid Verdict within ${MAX_TOOL_ITERATIONS} iterations`, '');
  }
}

/** Parses the model's final text block and validates it against the
 * Verdict contract (verdict-validation.ts) — JSON syntax errors and
 * schema violations (unknown severity, an evidence-less claim, an
 * unknown playbook, ...) both become an `UnparsableVerdictError`,
 * carrying enough detail (`formatValidationErrors`) for `investigate`'s
 * own repair prompt to tell the model exactly what to fix. */
export function parseVerdict(text: string): Verdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new UnparsableVerdictError(`model response was not valid JSON: ${(err as Error).message}`, text);
  }
  const result = validateVerdict(parsed);
  if (!result.ok) {
    throw new UnparsableVerdictError(`model response failed verdict validation: ${formatValidationErrors(result.errors)}`, text);
  }
  return result.verdict;
}
