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
import type { Counter } from '@opentelemetry/api';
import type { Verdict } from '@sentinel/schema';
import { TOOL_DEFINITIONS, executeTool, type ToolDependencies } from './tools/index.js';
import { validateVerdict, formatValidationErrors } from './verdict-validation.js';
import { PLAYBOOK_REGISTRY } from './playbook-registry.js';
import { validateGrounding, formatGroundingErrors, type GroundingError } from './grounding.js';
import { tenantContextBlock, type CacheMetrics, type CostRecording } from './triage.js';
import { wrapUntrustedData, UNTRUSTED_DATA_INSTRUCTION } from './injection-defense.js';
import type { TranscriptRecorder } from './transcript.js';
import { recordUsage } from './cost-budget.js';
import { usageFromAnthropic } from './pricing.js';

export interface CaseContext {
  caseId: string;
  tenantId: string;
  severity?: string;
  title?: string;
  score?: number;
  /** The case's own time window (`cases.window_start`/`window_end`) —
   * P4-04's grounding validator checks every cited event's time
   * against this, not against "now". `windowEnd` is null for a case
   * still open/accumulating. */
  windowStart: string;
  windowEnd: string | null;
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

/** Thrown when the model's evidence still fails grounding after the one
 * repair attempt AC4 allows (P4-04, TG1) — deliberately a DIFFERENT
 * error type from `UnparsableVerdictError`: `worker.ts` catches this one
 * specifically to degrade to a rule-only alert and page, rather than
 * routing it to the DLQ the way every other investigation failure is. */
export class GroundingFailedError extends Error {
  constructor(
    message: string,
    readonly errors: readonly GroundingError[],
  ) {
    super(message);
    this.name = 'GroundingFailedError';
  }
}

/** AC5: "grounding rejection rate is exported as a metric." Optional —
 * omitted entirely when no MeterProvider is wired (same pattern as
 * `tools` above), so this still compiles and runs without it. */
export interface GroundingMetrics {
  attempts: Counter;
  rejections: Counter;
}

const SYSTEM_PROMPT = `You are a security analyst investigating an escalated case. You may call the available tools to gather evidence before answering. When you are done, respond with ONLY a JSON object matching this exact shape, no other text:
{"severity": "critical"|"high"|"medium"|"low"|"info", "title": string, "claims": [{"text": string, "evidenceRef": string[] (non-empty, every claim must cite at least one piece of evidence)}], "attackChain": string[], "recommendedActions": [{"playbook": one of [${PLAYBOOK_REGISTRY.join(', ')}], "urgency": "now"|"today"|"later", "blastRadius": string}]}

${UNTRUSTED_DATA_INSTRUCTION}`;

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
  groundingMetrics?: GroundingMetrics;
  /** P4-05 AC3: the same per-tenant cache_control block triage.ts
   * shares — real cost savings on the EXPENSIVE model, not just the
   * cheap one, depend on this being wired. */
  cacheMetrics?: CacheMetrics;
  /** P4-06 AC1: records every real call's own token usage and cost —
   * the SAME seam triage.ts's own `costRecording` option is. */
  costRecording?: CostRecording;
  /** P4-11 AC1: records the full prompt/tool-call/response history for
   * every real investigation. Optional for the same reason every other
   * dependency here is — a caller without a Postgres pool wired yet
   * still compiles and runs. */
  transcriptRecorder?: TranscriptRecorder;
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
  private readonly groundingMetrics: GroundingMetrics | undefined;
  private readonly cacheMetrics: CacheMetrics | undefined;
  private readonly costRecording: CostRecording | undefined;
  private readonly transcriptRecorder: TranscriptRecorder | undefined;

  constructor(opts: AnthropicInvestigationModelOptions) {
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? 8192;
    this.tools = opts.tools;
    this.groundingMetrics = opts.groundingMetrics;
    this.cacheMetrics = opts.cacheMetrics;
    this.costRecording = opts.costRecording;
    this.transcriptRecorder = opts.transcriptRecorder;
  }

  async investigate(ctx: CaseContext): Promise<Verdict> {
    // P4-09 AC1: ctx.title ultimately traces back to signal/event data
    // this pipeline never fully controls end to end — wrapped as
    // untrusted the same as any tool result, even though severity/score
    // are deterministic enum/numeric values from upstream correlation,
    // not free text an attacker could shape.
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: `Case ${ctx.caseId} (tenant ${ctx.tenantId}): severity=${ctx.severity ?? 'unknown'}, score=${ctx.score ?? 'unknown'}. ${wrapUntrustedData('case.title', ctx.title ?? 'untitled')}`,
      },
    ];
    // AC3 (P4-03) / AC4 (P4-04): each is exactly one chance across the
    // WHOLE investigation, not one per malformed response — two
    // separate flags because a schema repair and a grounding repair are
    // different problems with different corrective prompts.
    let repairAttempted = false;
    let groundingRepairAttempted = false;
    // P4-11: identical across every iteration (nothing in it depends
    // on loop state), hoisted once so the transcript recorded at the
    // end captures exactly what was actually sent, without rebuilding
    // it a second time from scratch after the fact.
    const systemBlocks: Anthropic.TextBlockParam[] = [
      { type: 'text', text: SYSTEM_PROMPT },
      // P4-05 AC3: the IDENTICAL per-tenant block triage.ts caches —
      // sharing the one function, not a second copy of this text,
      // is what guarantees a byte-for-byte match (and therefore an
      // actual cache hit) across both tiers for the same tenant.
      { type: 'text', text: tenantContextBlock(ctx.tenantId), cache_control: { type: 'ephemeral' } },
    ];
    // Awaited, unlike the metrics dependencies above — AC1 ("every
    // investigation records...") is this ticket's primary deliverable,
    // not best-effort telemetry, so the investigation genuinely waits
    // for the write before returning. Still error-tolerant: a
    // transcript-store outage must not fail the investigation itself.
    const recordTranscript = async (finalResponseContent: Anthropic.ContentBlock[], verdict: Verdict): Promise<void> => {
      if (!this.transcriptRecorder) return;
      try {
        await this.transcriptRecorder.record(ctx.tenantId, ctx.caseId, { model: this.model, system: systemBlocks, messages, finalResponseContent, verdict });
      } catch {
        // best-effort — see above.
      }
    };

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: systemBlocks,
        messages,
        ...(this.tools ? { tools: TOOL_DEFINITIONS } : {}),
      });
      this.cacheMetrics?.calls.add(1, { tenant_id: ctx.tenantId });
      if ((response.usage.cache_read_input_tokens ?? 0) > 0) {
        this.cacheMetrics?.hits.add(1, { tenant_id: ctx.tenantId });
      }
      if (this.costRecording) {
        await recordUsage(
          this.costRecording.pool,
          ctx.tenantId,
          ctx.caseId,
          this.model,
          'investigation',
          usageFromAnthropic(response.usage),
          this.costRecording.priceTable,
          this.costRecording.costMetric,
        );
      }

      if (response.stop_reason === 'tool_use' && this.tools) {
        messages.push({ role: 'assistant', content: response.content });
        const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of toolUseBlocks) {
          const outcome = await executeTool(block.name, ctx.tenantId, block.input, this.tools);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: outcome.content });
        }
        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      const block = response.content.find((b) => b.type === 'text');
      const text = block && block.type === 'text' ? block.text : '';
      let verdict: Verdict;
      try {
        verdict = parseVerdict(text);
      } catch (err) {
        if (!(err instanceof UnparsableVerdictError) || repairAttempted) throw err;
        repairAttempted = true;
        messages.push({ role: 'assistant', content: response.content });
        messages.push({
          role: 'user',
          content: `Your previous response could not be used: ${err.message}. Respond again with ONLY a corrected JSON object matching the required shape — no other text.`,
        });
        continue;
      }

      // P4-04/TG1: deterministic re-verification against the real event
      // store, never a model self-check — skipped only when no
      // ClickHouse client is wired at all (same seam tool use shares).
      if (!this.tools) {
        await recordTranscript(response.content, verdict);
        return verdict;
      }

      const grounding = await validateGrounding(this.tools.ch, ctx.tenantId, { start: ctx.windowStart, end: ctx.windowEnd }, verdict);
      if (grounding.ok) {
        this.groundingMetrics?.attempts.add(1, { tenant_id: ctx.tenantId });
        await recordTranscript(response.content, verdict);
        return verdict;
      }

      if (groundingRepairAttempted) {
        this.groundingMetrics?.attempts.add(1, { tenant_id: ctx.tenantId });
        this.groundingMetrics?.rejections.add(1, { tenant_id: ctx.tenantId });
        throw new GroundingFailedError(formatGroundingErrors(grounding.errors), grounding.errors);
      }
      groundingRepairAttempted = true;
      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: `Your evidence could not be verified: ${formatGroundingErrors(grounding.errors)}. Revise your claims so every evidenceRef resolves to a real event within this case's time window, or remove the unverifiable claim. Respond again with ONLY the corrected JSON object.`,
      });
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
