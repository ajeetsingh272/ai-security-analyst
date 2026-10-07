/**
 * Tiered model routing (P4-05): triage on a cheap model before an
 * escalated case ever reaches the expensive investigation model —
 * "the single largest cost lever in the system," per the ticket's own
 * description. Critical-severity cases bypass this file entirely
 * (worker.ts's own routing decision, not this one's), since a case
 * already known to be severe gains nothing from a cheap-model opinion
 * and only adds latency before the real investigation starts.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Counter } from '@opentelemetry/api';
import type { Pool } from 'pg';
import type { CaseContext } from './investigation-model.js';
import { recordUsage } from './cost-budget.js';
import { usageFromAnthropic, type PriceTable } from './pricing.js';
import { wrapUntrustedData, UNTRUSTED_DATA_INSTRUCTION } from './injection-defense.js';

export type TriageDecisionKind = 'dismiss' | 'escalate';

export interface TriageDecision {
  decision: TriageDecisionKind;
  reason: string;
}

export interface TriageModel {
  triage(ctx: CaseContext): Promise<TriageDecision>;
}

/**
 * The stable, per-tenant system-prompt segment every triage (and
 * investigation) call for this tenant shares byte-for-byte — AC3's own
 * "structured for cache reuse." Deliberately excludes anything that
 * varies per case (severity, title, score): mixing case-specific text
 * into this block would invalidate the cache on every single call,
 * defeating the entire point. Exported so investigation-model.ts can
 * share the identical block rather than maintaining a second one that
 * could drift and silently stop being a cache hit against this one.
 */
export function tenantContextBlock(tenantId: string): string {
  return `Tenant context: you are evaluating cases for tenant ${tenantId}. Apply this tenant's own standards consistently across every case you see for it.`;
}

const TRIAGE_SYSTEM_PROMPT = `You are a security triage analyst. Given a case summary, decide whether it should be DISMISSED (no genuine threat, safe to close without full investigation) or ESCALATED (uncertain, suspicious, or clearly malicious — needs full investigation). Respond with ONLY a JSON object: {"decision": "dismiss"|"escalate", "reason": string}. When genuinely uncertain, escalate — a missed investigation is far worse than an unnecessary one.

${UNTRUSTED_DATA_INSTRUCTION}`;

export interface CacheMetrics {
  calls: Counter;
  hits: Counter;
}

export interface CostRecording {
  pool: Pool;
  priceTable: PriceTable;
  costMetric?: Counter;
}

export interface AnthropicTriageModelOptions {
  apiKey: string;
  model: string;
  maxTokens?: number;
  client?: Anthropic;
  cacheMetrics?: CacheMetrics;
  /** P4-06 AC1: every real call records its own token usage and cost.
   * Optional so a caller without a Postgres pool wired yet still
   * compiles and runs — the same seam `tools`/`groundingMetrics` are
   * in investigation-model.ts. */
  costRecording?: CostRecording;
}

export class AnthropicTriageModel implements TriageModel {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly cacheMetrics: CacheMetrics | undefined;
  private readonly costRecording: CostRecording | undefined;

  constructor(opts: AnthropicTriageModelOptions) {
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
    // AC4: the model identifier is whatever the caller's own
    // configuration (main.ts's ANTHROPIC_TRIAGE_MODEL) passed in — never
    // a literal baked into this class, so swapping it is a deploy-time
    // config change, not a code change.
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? 512;
    this.cacheMetrics = opts.cacheMetrics;
    this.costRecording = opts.costRecording;
  }

  async triage(ctx: CaseContext): Promise<TriageDecision> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: [
        { type: 'text', text: TRIAGE_SYSTEM_PROMPT },
        // AC3: this block, and only this block, carries cache_control —
        // the surrounding text differs between tenants and would never
        // hit cache anyway; this is the part that repeats.
        { type: 'text', text: tenantContextBlock(ctx.tenantId), cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        {
          role: 'user',
          content: `Case ${ctx.caseId}: severity=${ctx.severity ?? 'unknown'}, score=${ctx.score ?? 'unknown'}. ${wrapUntrustedData('case.title', ctx.title ?? 'untitled')}`,
        },
      ],
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
        'triage',
        usageFromAnthropic(response.usage),
        this.costRecording.priceTable,
        this.costRecording.costMetric,
      );
    }

    const block = response.content.find((b) => b.type === 'text');
    const text = block && block.type === 'text' ? block.text : '';
    return parseTriageDecision(text);
  }
}

/**
 * A triage response that can't be parsed fails safe to ESCALATE, never
 * to dismiss — this file's own job is to cheaply filter out NOISE, and
 * the worst outcome of a parsing bug here would be silently dropping a
 * real case, which is strictly worse than paying for an unnecessary
 * investigation.
 */
export function parseTriageDecision(text: string): TriageDecision {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.decision === 'dismiss' || parsed.decision === 'escalate') {
      const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
      // P4-12 AC1: "every AI dismissal records the model's stated
      // reason" — a dismiss decision with no reason at all is just as
      // untrustworthy as invalid JSON (there is nothing to show a
      // customer in the digest, and nothing a human could evaluate
      // if they disagreed), so it gets the SAME fail-safe-to-escalate
      // treatment as an unparseable response, not a silent dismissal.
      if (parsed.decision === 'dismiss' && reason.trim().length === 0) {
        return { decision: 'escalate', reason: 'triage returned dismiss with no reason, failing safe to escalate' };
      }
      return { decision: parsed.decision, reason };
    }
  } catch {
    // falls through to the fail-safe below
  }
  return { decision: 'escalate', reason: `triage response could not be parsed, failing safe to escalate: ${text}` };
}
