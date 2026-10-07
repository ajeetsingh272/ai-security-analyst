/**
 * P4-01 T1/T3/T4 — the real worker, against real Postgres and real
 * Redpanda. No real Anthropic API key is configured in this sandbox
 * (confirmed directly: ANTHROPIC_API_KEY is present but empty) — a
 * FakeInvestigationModel stands in for it throughout. That substitution
 * is scoped to exactly one seam (InvestigationModel), and everything
 * else — Kafka consumption, offset commits, Postgres case lookup,
 * per-tenant concurrency, retry, DLQ routing, graceful shutdown — runs
 * against the real infrastructure this whole project tests against
 * everywhere else.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Kafka, logLevel, type Consumer, type Producer } from 'kafkajs';
import pg, { type Pool } from 'pg';
import { createLogger, startTracing, type TracingHandle } from '@sentinel/observability';
import type { Verdict } from '@sentinel/schema';
import { AnalystWorker } from '../worker.js';
import { CASES_TOPIC, CASES_DLQ_TOPIC, tenantCaseKey } from '../kafka.js';
import { PermanentError } from '../retry.js';
import type { InvestigationModel, CaseContext } from '../investigation-model.js';

const BROKERS = [process.env.REDPANDA_BROKERS ?? 'localhost:19092'];
const JAEGER_URL = 'http://localhost:16686';
const TRACING_SERVICE_NAME = 'sentinel-analyst-test';

interface JaegerTrace {
  spans: Array<{ operationName: string }>;
}

/** AC5: "every stage emits a span on the case trace" — proven the
 * same way packages/observability's own cross-language-trace test
 * proves cross-language propagation: query the REAL Jaeger this dev
 * stack already runs, not just that startActiveSpan was called
 * (which would pass even against a no-op tracer with no
 * startTracing() ever having run — confirmed directly: an earlier
 * version of this test did exactly that, and Jaeger's own
 * /api/services never listed this service at all). */
async function waitForSpans(expectedOperations: readonly string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen: Set<string> = new Set();
  while (Date.now() < deadline) {
    const res = await fetch(`${JAEGER_URL}/api/traces?service=${TRACING_SERVICE_NAME}&limit=20`);
    if (res.ok) {
      const body = (await res.json()) as { data?: JaegerTrace[] };
      const seen = new Set((body.data ?? []).flatMap((t) => t.spans.map((s) => s.operationName)));
      lastSeen = seen;
      if (expectedOperations.every((op) => seen.has(op))) return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`spans [${expectedOperations.join(', ')}] did not all appear within ${timeoutMs}ms — last seen: [${[...lastSeen].join(', ')}]`);
}

const pool: Pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel',
});

async function asAdmin<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE sentinel_app');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function createTenantAndCase(): Promise<{ tenantId: string; caseId: string }> {
  const tenantId = await asAdmin(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO tenants (name, plan) VALUES ($1, 'trial') RETURNING id`,
      [`P4-01 analyst probe ${Date.now()}`],
    );
    return rows[0]!.id;
  });
  const caseId = await asAdmin(async (c) => {
    await c.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count, score)
       VALUES ($1, 'critical', 'P4-01 probe case', now(), 2, 50) RETURNING id`,
      [tenantId],
    );
    return rows[0]!.id;
  });
  return { tenantId, caseId };
}

async function deleteTenant(tenantId: string): Promise<void> {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
}

/** A fresh client/producer/consumer-group triple per test — the same
 * "never share Kafka state across tests" discipline the Go side's own
 * integration tests already follow throughout this project. */
function newKafkaHarness(): { kafka: Kafka; producer: Producer; consumer: Consumer; groupId: string } {
  const kafka = new Kafka({ clientId: `analyst-test-${randomUUID()}`, brokers: BROKERS, logLevel: logLevel.NOTHING });
  const groupId = `analyst-test-${randomUUID()}`;
  return { kafka, producer: kafka.producer(), consumer: kafka.consumer({ groupId }), groupId };
}

async function publishCaseEvent(producer: Producer, tenantId: string, caseId: string): Promise<void> {
  await producer.connect();
  await producer.send({
    topic: CASES_TOPIC,
    messages: [{ key: tenantCaseKey(tenantId, caseId), value: JSON.stringify({ tenant_id: tenantId, case_id: caseId }) }],
  });
}

class FakeInvestigationModel implements InvestigationModel {
  calls: CaseContext[] = [];
  constructor(private readonly behavior: (ctx: CaseContext) => Promise<Verdict>) {}
  async investigate(ctx: CaseContext): Promise<Verdict> {
    this.calls.push(ctx);
    return this.behavior(ctx);
  }
}

const CANNED_VERDICT: Verdict = {
  severity: 'critical',
  title: 'Test verdict',
  claims: [{ text: 'A test claim', evidenceRef: ['evt_test'] }],
  attackChain: ['T1078'],
  recommendedActions: [{ playbook: 'revoke_sessions', urgency: 'now', blastRadius: 'single_user' }],
};

/** Captures every log line into an array instead of real stdout —
 * @sentinel/observability's own `destination` option exists
 * specifically for this (its own doc comment: "Exists so tests can
 * capture output without a real file or network sink"). */
function capturingLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const destination = new Writable({
    write(chunk, _enc, callback) {
      lines.push(JSON.parse(chunk.toString()));
      callback();
    },
  });
  const logger = createLogger({ service: 'sentinel-analyst-test', destination });
  return { logger, lines };
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitUntil timed out: ${label}`);
}

let tracingHandle: TracingHandle;
beforeAll(() => {
  tracingHandle = startTracing({ serviceName: TRACING_SERVICE_NAME });
});

const cleanupTenants: string[] = [];
afterAll(async () => {
  for (const tenantId of cleanupTenants) await deleteTenant(tenantId).catch(() => {});
  await pool.end();
  await tracingHandle.shutdown();
});

const activeWorkers: AnalystWorker[] = [];
const activeConsumers: Consumer[] = [];
const activeProducers: Producer[] = [];
afterEach(async () => {
  for (const w of activeWorkers.splice(0)) await w.stop().catch(() => {});
  for (const c of activeConsumers.splice(0)) await c.disconnect().catch(() => {});
  for (const p of activeProducers.splice(0)) await p.disconnect().catch(() => {});
});

describe('AnalystWorker', () => {
  it('T1: a case flows through the worker and produces a verdict', async () => {
    const { tenantId, caseId } = await createTenantAndCase();
    cleanupTenants.push(tenantId);
    const harness = newKafkaHarness();
    activeConsumers.push(harness.consumer);
    activeProducers.push(harness.producer);

    const model = new FakeInvestigationModel(async () => CANNED_VERDICT);
    const { logger, lines } = capturingLogger();
    const worker = new AnalystWorker({
      consumer: harness.consumer,
      producer: harness.kafka.producer(),
      pool,
      investigationModel: model,
      logger,
      concurrencyPerTenant: 5,
      partitionsConsumedConcurrently: 4,
      retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
      isRetryable: () => false,
    });
    activeWorkers.push(worker);
    await worker.start();

    await publishCaseEvent(harness.producer, tenantId, caseId);

    await waitUntil(() => model.calls.length > 0, 10_000, 'investigation model to be called');
    expect(model.calls[0]).toMatchObject({ caseId, tenantId, severity: 'critical' });

    await waitUntil(
      () => lines.some((l) => l.msg === 'investigation produced a verdict' && l.case_id === caseId),
      5_000,
      'verdict-produced log line',
    );

    // AC5: "every stage emits a span on the case trace" — against the
    // real Jaeger this dev stack runs, not merely that
    // startActiveSpan was called (see waitForSpans' own doc comment
    // for why that distinction matters and was caught directly).
    await waitForSpans(['case.investigate', 'case.fetch', 'case.llm_investigation'], 10_000);
  });

  it('T3: a permanently failing case reaches the DLQ and raises an alert', async () => {
    const { tenantId, caseId } = await createTenantAndCase();
    cleanupTenants.push(tenantId);
    const harness = newKafkaHarness();
    activeConsumers.push(harness.consumer);
    activeProducers.push(harness.producer);

    const dlqConsumer = harness.kafka.consumer({ groupId: `${harness.groupId}-dlq-reader` });
    activeConsumers.push(dlqConsumer);
    await dlqConsumer.connect();
    await dlqConsumer.subscribe({ topic: CASES_DLQ_TOPIC, fromBeginning: false });
    const dlqMessages: Array<Record<string, unknown>> = [];
    await dlqConsumer.run({
      eachMessage: async ({ message }) => {
        if (message.value) dlqMessages.push(JSON.parse(message.value.toString()));
      },
    });

    const model = new FakeInvestigationModel(async () => {
      throw new PermanentError('this case can never be investigated');
    });
    const { logger, lines } = capturingLogger();
    const worker = new AnalystWorker({
      consumer: harness.consumer,
      producer: harness.kafka.producer(),
      pool,
      investigationModel: model,
      logger,
      concurrencyPerTenant: 5,
      partitionsConsumedConcurrently: 4,
      retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
      isRetryable: () => true, // irrelevant: PermanentError is never retried regardless
    });
    activeWorkers.push(worker);
    await worker.start();

    await publishCaseEvent(harness.producer, tenantId, caseId);

    await waitUntil(() => dlqMessages.some((m) => m.case_id === caseId), 10_000, 'a message on cases.dlq');
    const dlqMsg = dlqMessages.find((m) => m.case_id === caseId)!;
    expect(dlqMsg).toMatchObject({ tenant_id: tenantId, case_id: caseId, error: 'this case can never be investigated' });

    await waitUntil(
      () => lines.some((l) => l.page === true && l.case_id === caseId && l.level === 50),
      5_000,
      'a paging-level error log line',
    );
  });

  it('T4: shutdown drains an in-flight investigation before disconnecting', async () => {
    const { tenantId, caseId } = await createTenantAndCase();
    cleanupTenants.push(tenantId);
    const harness = newKafkaHarness();
    activeConsumers.push(harness.consumer);
    activeProducers.push(harness.producer);

    let investigationFinished = false;
    let releaseInvestigation!: () => void;
    const gate = new Promise<void>((resolve) => (releaseInvestigation = resolve));
    const model = new FakeInvestigationModel(async () => {
      await gate;
      investigationFinished = true;
      return CANNED_VERDICT;
    });
    const { logger } = capturingLogger();
    const worker = new AnalystWorker({
      consumer: harness.consumer,
      producer: harness.kafka.producer(),
      pool,
      investigationModel: model,
      logger,
      concurrencyPerTenant: 5,
      partitionsConsumedConcurrently: 4,
      retry: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 100 },
      isRetryable: () => false,
    });
    await worker.start();

    await publishCaseEvent(harness.producer, tenantId, caseId);
    await waitUntil(() => model.calls.length > 0, 10_000, 'investigation to start');

    // stop() must not resolve while the investigation above is still
    // blocked on `gate` — if it did, that would mean shutdown dropped
    // in-flight work instead of draining it (AC4).
    let stopResolved = false;
    const stopPromise = worker.stop().then(() => {
      stopResolved = true;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(stopResolved).toBe(false);
    expect(investigationFinished).toBe(false);

    releaseInvestigation();
    await stopPromise;
    expect(stopResolved).toBe(true);
    expect(investigationFinished).toBe(true);
  });
});
