/**
 * P4-10 T2/T3 — the full degradation-and-recovery loop against REAL
 * Postgres and REAL Redpanda: a provider outage opens the circuit,
 * degrades the in-flight case to a rule-only alert, queues it, and a
 * later successful call (the provider recovering) drains that queue
 * by re-publishing the case back onto `cases` — which THIS SAME
 * running worker then picks up and genuinely re-investigates, proving
 * the loop closes for real rather than merely asserting the queue row
 * exists.
 *
 * T1 (the breaker itself opens within threshold) is proven as a pure
 * unit test in circuit-breaker.test.ts — no real infra needed for that
 * claim. T4 (visible in the dashboard) is its own metrics integration
 * test (circuit-breaker-metrics.integration.test.ts).
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Kafka, logLevel, type Consumer, type Producer } from 'kafkajs';
import pg, { type Pool } from 'pg';
import { createLogger } from '@sentinel/observability';
import type { Verdict } from '@sentinel/schema';
import { AnalystWorker } from '../worker.js';
import { CASES_TOPIC, tenantCaseKey } from '../kafka.js';
import type { InvestigationModel, CaseContext } from '../investigation-model.js';
import type { TriageModel, TriageDecision } from '../triage.js';
import { CircuitBreaker } from '../circuit-breaker.js';

const BROKERS = [process.env.REDPANDA_BROKERS ?? 'localhost:19092'];
const pool: Pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel' });

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

async function createTenantAndCase(scenario: string): Promise<{ tenantId: string; caseId: string }> {
  const tenantId = await asAdmin(async (c) => {
    const { rows } = await c.query<{ id: string }>(`INSERT INTO tenants (name, plan) VALUES ($1, 'trial') RETURNING id`, [
      `P4-10 probe ${Date.now()}`,
    ]);
    return rows[0]!.id;
  });
  const caseId = await asAdmin(async (c) => {
    await c.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count, score)
       VALUES ($1, 'critical', $2, now(), 1, 50) RETURNING id`,
      [tenantId, scenario],
    );
    return rows[0]!.id;
  });
  return { tenantId, caseId };
}

async function createCaseForTenant(tenantId: string, scenario: string): Promise<string> {
  return asAdmin(async (c) => {
    await c.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO cases (tenant_id, severity, title, window_start, signal_count, score)
       VALUES ($1, 'critical', $2, now(), 1, 50) RETURNING id`,
      [tenantId, scenario],
    );
    return rows[0]!.id;
  });
}

async function deleteTenant(tenantId: string): Promise<void> {
  await asAdmin((c) => c.query('DELETE FROM tenants WHERE id = $1', [tenantId]));
}

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

class FakeProviderUnavailableError extends Error {
  constructor() {
    super('503 service unavailable (fake)');
  }
}

const CANNED_VERDICT: Verdict = {
  severity: 'critical',
  title: 'Recovered investigation',
  claims: [{ text: 'A test claim', evidenceRef: ['evt_test'] }],
  attackChain: [],
  recommendedActions: [{ playbook: 'revoke_sessions', urgency: 'now', blastRadius: 'single_user' }],
};

/** Fails every call while `outage` is true, succeeds once it's
 * flipped — simulating a provider outage followed by recovery. */
class FlakyInvestigationModel implements InvestigationModel {
  calls: CaseContext[] = [];
  outage = true;
  async investigate(ctx: CaseContext): Promise<Verdict> {
    this.calls.push(ctx);
    if (this.outage) throw new FakeProviderUnavailableError();
    return CANNED_VERDICT;
  }
}

class AlwaysEscalateTriageModel implements TriageModel {
  async triage(): Promise<TriageDecision> {
    return { decision: 'escalate', reason: 'test' };
  }
}

function capturingLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const destination = new Writable({
    write(chunk, _enc, callback) {
      lines.push(JSON.parse(chunk.toString()));
      callback();
    },
  });
  return { logger: createLogger({ service: 'sentinel-analyst-test', destination }), lines };
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitUntil timed out: ${label}`);
}

const cleanupTenants: string[] = [];
const activeWorkers: AnalystWorker[] = [];
const activeConsumers: Consumer[] = [];
const activeProducers: Producer[] = [];

afterEach(async () => {
  for (const w of activeWorkers.splice(0)) await w.stop().catch(() => {});
  for (const c of activeConsumers.splice(0)) await c.disconnect().catch(() => {});
  for (const p of activeProducers.splice(0)) await p.disconnect().catch(() => {});
});

afterAll(async () => {
  for (const tenantId of cleanupTenants) await deleteTenant(tenantId).catch(() => {});
  await pool.end();
});

describe('P4-10: analyst degradation path when the LLM provider is unavailable', () => {
  it('T2/T3: an outage degrades the case to a rule-only alert and queues it; recovery re-investigates it exactly once, no duplicate degrade alert', async () => {
    const { tenantId, caseId: outageCaseId } = await createTenantAndCase('case during outage');
    cleanupTenants.push(tenantId);
    const harness = newKafkaHarness();
    activeConsumers.push(harness.consumer);
    activeProducers.push(harness.producer);

    const investigationModel = new FlakyInvestigationModel();
    const circuitBreaker = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 200 });
    const { logger, lines } = capturingLogger();
    const worker = new AnalystWorker({
      consumer: harness.consumer,
      producer: harness.kafka.producer(),
      pool,
      investigationModel,
      triageModel: new AlwaysEscalateTriageModel(),
      logger,
      concurrencyPerTenant: 5,
      partitionsConsumedConcurrently: 4,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }, // no retry noise — one failure is enough to observe the breaker
      isRetryable: () => false,
      circuitBreaker,
      isProviderFailure: (err) => err instanceof FakeProviderUnavailableError,
    });
    activeWorkers.push(worker);
    await worker.start();

    // T2: the outage case is degraded, not DLQ'd, and the queue picks it up.
    await publishCaseEvent(harness.producer, tenantId, outageCaseId);
    await waitUntil(
      () => lines.some((l) => l.case_id === outageCaseId && l.rule_only_alert === true && l.degrade_reason === 'llm_provider_unavailable'),
      10_000,
      'the provider-unavailable degrade log line',
    );
    expect(circuitBreaker.getState()).not.toBe('closed');

    // The provider "recovers": flip the fake model, wait out the
    // breaker's own open duration, then let a SECOND, different case
    // succeed — that success is what triggers the drain.
    investigationModel.outage = false;
    await new Promise((r) => setTimeout(r, 250));
    const recoveryCaseId = await createCaseForTenant(tenantId, 'case after recovery');
    await publishCaseEvent(harness.producer, tenantId, recoveryCaseId);

    await waitUntil(
      () => lines.some((l) => l.case_id === recoveryCaseId && l.msg === 'report generated'),
      10_000,
      'the recovery case to produce a real verdict',
    );
    await waitUntil(
      () => lines.some((l) => l.degraded_mode === false),
      10_000,
      'the circuit-breaker-recovered log line',
    );

    // T3: the ORIGINAL outage case gets re-investigated for real —
    // drained and re-published back onto cases, which this same
    // worker then genuinely processes again.
    await waitUntil(
      () => lines.some((l) => l.case_id === outageCaseId && l.msg === 'report generated'),
      10_000,
      'the outage case to be re-investigated after recovery',
    );

    // "Without duplicate notifications": the degrade alert for the
    // outage case fired exactly once, never a second time.
    const degradeLinesForOutageCase = lines.filter((l) => l.case_id === outageCaseId && l.rule_only_alert === true);
    expect(degradeLinesForOutageCase).toHaveLength(1);
  }, 30_000);
});
