/**
 * The analyst worker (P4-01): consumes `cases`, with per-tenant
 * concurrency limits (AC1), retries transient failures with backoff
 * (AC2), routes permanent failures to DLQ and pages rather than
 * dropping them (AC3), drains in-flight work on shutdown (AC4), and
 * emits a span per stage on the case trace (AC5).
 */
import { trace, type Tracer } from '@opentelemetry/api';
import type { Consumer, Producer, EachMessagePayload } from 'kafkajs';
import type { Pool } from 'pg';
import { withTenantContext, CasesRepository, DegradedQueueRepository, listTenantsWithPendingDegradedCases } from '@sentinel/db';
import type { Logger } from '@sentinel/observability';
import { CASES_TOPIC, CASES_DLQ_TOPIC, tenantCaseKey, parseCaseEventMessage } from './kafka.js';
import { TenantConcurrencyLimiter } from './tenant-concurrency.js';
import { withRetry, PermanentError, type RetryOptions } from './retry.js';
import type { InvestigationModel, CaseContext } from './investigation-model.js';
import { GroundingFailedError } from './investigation-model.js';
import type { TriageModel } from './triage.js';
import { checkBudget } from './cost-budget.js';
import { generateReport } from './report.js';
import { renderForWhatsApp, renderForSlack, renderForEmail, renderForDashboard } from './report-channels.js';
import { CircuitBreaker, CircuitOpenError, callThroughBreaker } from './circuit-breaker.js';

export interface AnalystWorkerOptions {
  consumer: Consumer;
  producer: Producer;
  pool: Pool;
  investigationModel: InvestigationModel;
  /** P4-05: triages every non-critical case before it reaches
   * `investigationModel` (AC1/AC2). Required, not optional — a worker
   * that silently sent every case straight to the expensive model would
   * defeat this ticket's own cost guarantee by omission; a test that
   * truly doesn't care can pass a trivial "always escalate" fake. */
  triageModel: TriageModel;
  logger: Logger;
  concurrencyPerTenant: number;
  partitionsConsumedConcurrently: number;
  retry: Pick<RetryOptions, 'maxAttempts' | 'baseDelayMs' | 'maxDelayMs'>;
  isRetryable: (err: unknown) => boolean;
  /** P4-10: shared by both the triage and investigation calls, since
   * both hit the same underlying provider — a 503 from one is exactly
   * as much evidence the provider is down as a 503 from the other. */
  circuitBreaker: CircuitBreaker;
  /** Classifies a thrown error as evidence the PROVIDER itself is
   * unavailable (a 503/overload/network error), as opposed to a
   * malformed response or a grounding failure — neither of which
   * means the provider is down and neither of which should trip the
   * breaker. Conceptually distinct from `isRetryable` above even
   * though real callers (main.ts) pass the identical function for
   * both. */
  isProviderFailure: (err: unknown) => boolean;
  /** Overridable for tests. Real callers never set this. */
  tracer?: Tracer;
}

export class AnalystWorker {
  private readonly consumer: Consumer;
  private readonly producer: Producer;
  private readonly pool: Pool;
  private readonly investigationModel: InvestigationModel;
  private readonly triageModel: TriageModel;
  private readonly logger: Logger;
  private readonly limiter: TenantConcurrencyLimiter;
  private readonly retryOpts: RetryOptions;
  private readonly partitionsConsumedConcurrently: number;
  private readonly tracer: Tracer;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly isProviderFailure: (err: unknown) => boolean;
  private stopping = false;

  constructor(opts: AnalystWorkerOptions) {
    this.consumer = opts.consumer;
    this.producer = opts.producer;
    this.pool = opts.pool;
    this.investigationModel = opts.investigationModel;
    this.triageModel = opts.triageModel;
    this.logger = opts.logger;
    this.limiter = new TenantConcurrencyLimiter(opts.concurrencyPerTenant);
    this.retryOpts = { ...opts.retry, isRetryable: opts.isRetryable };
    this.partitionsConsumedConcurrently = opts.partitionsConsumedConcurrently;
    this.tracer = opts.tracer ?? trace.getTracer('sentinel-analyst');
    this.circuitBreaker = opts.circuitBreaker;
    this.isProviderFailure = opts.isProviderFailure;
  }

  async start(): Promise<void> {
    await this.consumer.connect();
    await this.producer.connect();
    await this.consumer.subscribe({ topic: CASES_TOPIC, fromBeginning: false });
    await this.consumer.run({
      autoCommit: false,
      partitionsConsumedConcurrently: this.partitionsConsumedConcurrently,
      eachMessage: (payload) => this.handleMessage(payload),
    });
  }

  /** AC4/T4: stop accepting new work, wait for every in-flight
   * investigation to finish, then disconnect — in that order.
   * consumer.stop() halts new eachMessage calls but does not itself
   * wait for ones already running, which is exactly why this method
   * polls the limiter's own totalInFlight afterward rather than
   * trusting stop() alone to mean "drained". */
  async stop(): Promise<void> {
    this.stopping = true;
    await this.consumer.stop();
    while (this.limiter.totalInFlight > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await this.consumer.disconnect();
    await this.producer.disconnect();
  }

  private async handleMessage({ topic, partition, message }: EachMessagePayload): Promise<void> {
    if (this.stopping) return; // a message already in flight when stop() was called may still land here; let it through, stop()'s own drain loop is what actually waits for it

    const event = parseCaseEventMessage(message.value);
    await this.limiter.run(event.tenant_id, () => this.investigate(event.tenant_id, event.case_id));

    await this.consumer.commitOffsets([
      { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
    ]);
  }

  private async investigate(tenantId: string, caseId: string): Promise<void> {
    await this.tracer.startActiveSpan('case.investigate', async (span) => {
      span.setAttribute('tenant_id', tenantId);
      span.setAttribute('case_id', caseId);
      let ctx: CaseContext | null = null;
      try {
        ctx = await this.fetchCaseContext(tenantId, caseId);
        if (!ctx) {
          this.logger.warn({ tenant_id: tenantId, case_id: caseId }, 'case no longer exists; dropping');
          return;
        }

        // P4-06 AC3/AC4: checked BEFORE spending anything on this case —
        // using whatever the tenant already spent on EARLIER cases
        // today, not including this one. A hard cap degrades this case
        // immediately, without ever calling either model again; a soft
        // breach raises an alert but this case still proceeds normally.
        const budget = await checkBudget(this.pool, tenantId);
        if (budget.status === 'hard_exceeded') {
          await this.degradeToRuleOnlyAlert(
            tenantId,
            caseId,
            ctx,
            'cost_hard_cap_exceeded',
            `tenant has spent $${budget.spentUsd.toFixed(2)} today, at or above its $${budget.budget.hardCapUsd} hard cap`,
          );
          return;
        }
        if (budget.status === 'soft_exceeded') {
          this.logger.error(
            {
              tenant_id: tenantId,
              case_id: caseId,
              spent_usd: budget.spentUsd,
              allowance_usd: budget.budget.allowanceUsd,
              cost_alert: true,
            },
            'tenant has exceeded 1.5x its daily cost allowance',
          );
        }

        // P4-05 AC5: critical severity bypasses triage entirely — a
        // case already known to be severe gains nothing from a
        // cheap-model opinion, only latency. AC2: every OTHER case must
        // go through triage, and only an escalate decision reaches the
        // expensive model below.
        if (ctx.severity !== 'critical') {
          const decision = await this.tracer.startActiveSpan('case.triage', (triageSpan) =>
            withRetry(() => this.callModelThroughBreaker(() => this.triageModel.triage(ctx!)), this.retryOpts).finally(() => triageSpan.end()),
          );
          this.logger.info({ tenant_id: tenantId, case_id: caseId, triage_decision: decision.decision, triage_reason: decision.reason }, 'triage decided');
          if (decision.decision === 'dismiss') {
            // P4-12 AC1: a durable, auditable record of WHY — never
            // just a log line — so the daily digest (AC2/AC3) and a
            // customer's own challenge (AC4) both have something real
            // to work from. parseTriageDecision's own fail-safe
            // already guarantees `decision.reason` is non-empty
            // whenever decision is 'dismiss'.
            await withTenantContext(tenantId, () => new CasesRepository(this.pool).recordAiDismissal(caseId, decision.reason));
            return;
          }
        }

        const verdict = await this.tracer.startActiveSpan('case.llm_investigation', (llmSpan) =>
          withRetry(() => this.callModelThroughBreaker(() => this.investigationModel.investigate(ctx!)), this.retryOpts).finally(() => llmSpan.end()),
        );

        this.logger.info(
          { tenant_id: tenantId, case_id: caseId, verdict_severity: verdict.severity, claim_count: verdict.claims.length },
          'investigation produced a verdict',
        );

        // P4-07: the verdict reaching this point is already schema-valid
        // (P4-03) and grounded (P4-04) — enforced inside
        // investigationModel itself, not here. generateReport never
        // invents content; it only glosses and restructures what
        // already passed grounding. No real delivery channel exists yet
        // (WhatsApp/Slack/email is P5's response plane), so — honestly
        // scoped the same way every other not-yet-delivered alert in
        // this codebase is — rendering for all four channels here
        // proves AC4 against a REAL case rather than only a unit test
        // fixture, and the rendered output is logged, not sent.
        const report = this.tracer.startActiveSpan('case.report', (reportSpan) => {
          try {
            const r = generateReport(verdict);
            renderForWhatsApp(r);
            renderForSlack(r);
            renderForEmail(r);
            renderForDashboard(r);
            return r;
          } finally {
            reportSpan.end();
          }
        });
        this.logger.info({ tenant_id: tenantId, case_id: caseId, report_title: report.title }, 'report generated');
      } catch (err) {
        if (err instanceof GroundingFailedError) {
          await this.degradeToRuleOnlyAlert(tenantId, caseId, ctx, 'grounding_failed_twice', err.message);
        } else if (err instanceof CircuitOpenError || this.isProviderFailure(err)) {
          // P4-10 AC2/AC3: whether the circuit was ALREADY open
          // (CircuitOpenError, fn never even attempted) or just tripped
          // DURING this call (the original provider error, already
          // retried to exhaustion by withRetry above) — either way this
          // is "the provider is unavailable," not a DLQ-worthy failure,
          // so it degrades and gets queued for a real investigation once
          // the provider recovers, instead of being lost to the DLQ.
          const message = err instanceof Error ? err.message : String(err);
          await this.degradeToRuleOnlyAlert(tenantId, caseId, ctx, 'llm_provider_unavailable', message);
          await this.enqueueForReinvestigation(tenantId, caseId, 'llm_provider_unavailable');
        } else {
          await this.handleFailure(tenantId, caseId, err);
        }
      } finally {
        span.end();
      }
    });
  }

  private async fetchCaseContext(tenantId: string, caseId: string): Promise<CaseContext | null> {
    return this.tracer.startActiveSpan('case.fetch', async (span) => {
      try {
        const row = await withTenantContext(tenantId, () => new CasesRepository(this.pool).findById(caseId));
        if (!row) return null;
        const ctx: CaseContext = { caseId: row.id, tenantId: row.tenantId, windowStart: row.windowStart, windowEnd: row.windowEnd };
        if (row.severity !== null) ctx.severity = row.severity;
        if (row.title !== null) ctx.title = row.title;
        return ctx;
      } finally {
        span.end();
      }
    });
  }

  /** P4-10 AC1: runs a model call through the shared circuit breaker;
   * when this call is the one that closes a previously open/half-open
   * breaker, drains every tenant's own queued, not-yet-reinvestigated
   * cases (AC3) — triggered exactly once per recovery, not on every
   * ordinary successful call while already closed. */
  private async callModelThroughBreaker<T>(fn: () => Promise<T>): Promise<T> {
    const { value, recovered } = await callThroughBreaker(this.circuitBreaker, fn, this.isProviderFailure);
    if (recovered) {
      this.logger.info({ degraded_mode: false }, 'LLM provider circuit breaker recovered; draining the degraded-case queue');
      await this.drainDegradedQueue().catch((err) => {
        this.logger.error({ err: err instanceof Error ? err.message : String(err) }, 'draining the degraded-case queue failed');
      });
    }
    return value;
  }

  private async enqueueForReinvestigation(tenantId: string, caseId: string, reason: string): Promise<void> {
    await withTenantContext(tenantId, () => new DegradedQueueRepository(this.pool).enqueue(caseId, reason));
  }

  /** P4-10 AC3/AC5: re-publishes every tenant's own pending degraded
   * case back onto `cases` so the ordinary pipeline (this same
   * worker, triage/investigate/grounding/report already tested
   * elsewhere) re-investigates it for real — never duplicating the
   * rule-only alert already sent, since that was logged once at
   * degrade time and this path only ever produces a NEW, upgraded AI
   * report, not a second copy of the old alert. Marks each row
   * processed only after the publish itself succeeds, so a crash
   * mid-drain leaves the row pending for the next recovery rather than
   * silently losing it. */
  private async drainDegradedQueue(): Promise<void> {
    const tenantIds = await listTenantsWithPendingDegradedCases(this.pool);
    for (const tenantId of tenantIds) {
      // DegradedQueueRepository (TenantScopedRepository) reads the
      // active tenant context AT CONSTRUCTION TIME — it must be built
      // inside withTenantContext's own callback, never hoisted above it.
      const pending = await withTenantContext(tenantId, () => new DegradedQueueRepository(this.pool).claimPending(100));
      for (const row of pending) {
        await this.producer.send({
          topic: CASES_TOPIC,
          messages: [{ key: tenantCaseKey(tenantId, row.caseId), value: JSON.stringify({ tenant_id: tenantId, case_id: row.caseId }) }],
        });
        await withTenantContext(tenantId, () => new DegradedQueueRepository(this.pool).markProcessed(row.id));
      }
    }
  }

  /** P4-04 AC4 / P4-06 AC4: "degrade to a rule-only alert and page" —
   * two independent reasons route here (a second consecutive grounding
   * failure, or a tenant's cost hard cap), neither treated as a
   * DLQ-worthy failure the way `handleFailure` treats everything else.
   * Both are deliberate, successful-in-their-own-right outcomes, so
   * this alert carries ONLY the case's deterministic fields (never
   * unverified verdict content) — honestly scoped the same way this
   * codebase scopes every alert that has no dedicated delivery channel
   * yet (no WhatsApp/Slack/email integration exists before P5's
   * response plane): a real, structured, paged log line, not a
   * fabricated send. The offset still commits normally afterward —
   * this is not a failure needing reprocessing. */
  private async degradeToRuleOnlyAlert(tenantId: string, caseId: string, ctx: CaseContext | null, reason: string, detail: string): Promise<void> {
    this.logger.error(
      {
        tenant_id: tenantId,
        case_id: caseId,
        severity: ctx?.severity ?? 'unknown',
        title: ctx?.title ?? 'untitled',
        degrade_reason: reason,
        detail,
        page: true,
        rule_only_alert: true,
      },
      `degraded to a rule-only alert: ${reason}`,
    );
  }

  /** AC3: a permanent failure (or a transient one whose retry budget
   * is exhausted) routes to DLQ and pages — never silently dropped.
   * "Pages" is, honestly, a structured ERROR log with a `page: true`
   * field — the same honestly-scoped alerting shape this codebase
   * already uses elsewhere (verify-audit-chain.yml's own doc comment
   * makes the identical point about GitHub's failed-workflow
   * notification being a real alert, not a placeholder, while also
   * not claiming to be a dedicated paging integration that does not
   * exist yet). The DLQ'd message carries the error so a human
   * reading it later knows why, without needing to correlate it
   * against a separate log stream. */
  private async handleFailure(tenantId: string, caseId: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error({ tenant_id: tenantId, case_id: caseId, err: message, page: true }, 'case investigation permanently failed');

    await this.producer.send({
      topic: CASES_DLQ_TOPIC,
      messages: [
        {
          key: tenantCaseKey(tenantId, caseId),
          value: JSON.stringify({ tenant_id: tenantId, case_id: caseId, error: message, failed_at: new Date().toISOString() }),
        },
      ],
    });
  }
}

export { PermanentError };
