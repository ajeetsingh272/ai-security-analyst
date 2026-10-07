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
import { withTenantContext, CasesRepository } from '@sentinel/db';
import type { Logger } from '@sentinel/observability';
import { CASES_TOPIC, CASES_DLQ_TOPIC, tenantCaseKey, parseCaseEventMessage } from './kafka.js';
import { TenantConcurrencyLimiter } from './tenant-concurrency.js';
import { withRetry, PermanentError, type RetryOptions } from './retry.js';
import type { InvestigationModel, CaseContext } from './investigation-model.js';

export interface AnalystWorkerOptions {
  consumer: Consumer;
  producer: Producer;
  pool: Pool;
  investigationModel: InvestigationModel;
  logger: Logger;
  concurrencyPerTenant: number;
  partitionsConsumedConcurrently: number;
  retry: Pick<RetryOptions, 'maxAttempts' | 'baseDelayMs' | 'maxDelayMs'>;
  isRetryable: (err: unknown) => boolean;
  /** Overridable for tests. Real callers never set this. */
  tracer?: Tracer;
}

export class AnalystWorker {
  private readonly consumer: Consumer;
  private readonly producer: Producer;
  private readonly pool: Pool;
  private readonly investigationModel: InvestigationModel;
  private readonly logger: Logger;
  private readonly limiter: TenantConcurrencyLimiter;
  private readonly retryOpts: RetryOptions;
  private readonly partitionsConsumedConcurrently: number;
  private readonly tracer: Tracer;
  private stopping = false;

  constructor(opts: AnalystWorkerOptions) {
    this.consumer = opts.consumer;
    this.producer = opts.producer;
    this.pool = opts.pool;
    this.investigationModel = opts.investigationModel;
    this.logger = opts.logger;
    this.limiter = new TenantConcurrencyLimiter(opts.concurrencyPerTenant);
    this.retryOpts = { ...opts.retry, isRetryable: opts.isRetryable };
    this.partitionsConsumedConcurrently = opts.partitionsConsumedConcurrently;
    this.tracer = opts.tracer ?? trace.getTracer('sentinel-analyst');
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
      try {
        const ctx = await this.fetchCaseContext(tenantId, caseId);
        if (!ctx) {
          this.logger.warn({ tenant_id: tenantId, case_id: caseId }, 'case no longer exists; dropping');
          return;
        }

        const verdict = await this.tracer.startActiveSpan('case.llm_investigation', (llmSpan) =>
          withRetry(() => this.investigationModel.investigate(ctx), this.retryOpts).finally(() => llmSpan.end()),
        );

        this.logger.info(
          { tenant_id: tenantId, case_id: caseId, verdict_severity: verdict.severity, claim_count: verdict.claims.length },
          'investigation produced a verdict',
        );
        // P4-01's own scope ends here: persisting/validating/reporting
        // the verdict is P4-03 (structured contract) / P4-04 (grounding
        // validator) / P4-07 (report generation)'s job. This ticket's
        // only claim is that the worker SKELETON reaches this point.
      } catch (err) {
        await this.handleFailure(tenantId, caseId, err);
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
        const ctx: CaseContext = { caseId: row.id, tenantId: row.tenantId };
        if (row.severity !== null) ctx.severity = row.severity;
        if (row.title !== null) ctx.title = row.title;
        return ctx;
      } finally {
        span.end();
      }
    });
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
