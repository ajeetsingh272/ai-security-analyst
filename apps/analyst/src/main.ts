/**
 * The analyst worker's real entrypoint (P4-01) — wires real Kafka,
 * real Postgres, a real (or absent) Anthropic client, starts
 * tracing, and drains in-flight work on SIGINT/SIGTERM before
 * exiting. Mirrors cmd/correlate/main.go's own graceful-shutdown
 * shape (services/correlate), translated to Node's signal API.
 */
import { Pool } from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { createLogger, startTracing, createMeter } from '@sentinel/observability';
import { createKafkaClients } from './kafka.js';
import { createTenantScopedClickHouseClient } from './clickhouse.js';
import { AnalystWorker } from './worker.js';
import { AnthropicInvestigationModel } from './investigation-model.js';
import { AnthropicTriageModel } from './triage.js';
import { loadPriceTable } from './pricing.js';
import { CircuitBreaker, type CircuitState } from './circuit-breaker.js';
import { PostgresTranscriptRecorder } from './transcript.js';
import { purgeExpiredTranscripts } from '@sentinel/db';
import { generateDailyDigests } from './digest.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PermanentError } from './retry.js';

function envOr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function isRetryableAnthropicError(err: unknown): boolean {
  if (!(err instanceof Anthropic.APIError)) return false;
  // 529 is Anthropic's own "overloaded" status (not a standard HTTP
  // code); 429 is rate-limiting; anything >=500 is the provider's own
  // fault, not the request's — all worth retrying. 4xx (other than
  // 429) means the request itself is wrong and will fail identically
  // on retry.
  return err.status === 529 || err.status === 429 || (err.status !== undefined && err.status >= 500);
}

async function main(): Promise<void> {
  const logger = createLogger({ service: 'sentinel-analyst' });
  const tracingHandle = startTracing({ serviceName: 'sentinel-analyst' });
  const meterHandle = createMeter({ serviceName: 'sentinel-analyst' });
  // P4-04 AC5: "grounding rejection rate is exported as a metric with
  // an alert above 2%" — infra/docker/grafana-provisioning/alerting/
  // grounding-rejection-rate.yml is the alert rule half.
  const groundingMetrics = {
    attempts: meterHandle.meter.createCounter('analyst.grounding.attempts', { description: 'Investigations that reached a grounding verdict (pass or fail)' }),
    rejections: meterHandle.meter.createCounter('analyst.grounding.rejections', { description: 'Investigations whose evidence failed grounding even after one repair attempt' }),
  };
  // P4-05 AC3: "cache hit rate is measured" — shared by both tiers,
  // since the SAME tenant-context block (triage.ts's own
  // tenantContextBlock) is cached across triage AND investigation calls.
  const cacheMetrics = {
    calls: meterHandle.meter.createCounter('analyst.prompt_cache.calls', { description: 'Anthropic calls (triage + investigation) eligible for a cached tenant-context block' }),
    hits: meterHandle.meter.createCounter('analyst.prompt_cache.hits', { description: 'Those calls where cache_read_input_tokens > 0' }),
  };
  // P4-06 AC2: "configurable price table, not hardcoded rates."
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const priceTable = loadPriceTable(envOr('MODEL_PRICES_PATH', path.join(__dirname, '..', 'config', 'model-prices.json')));
  const costMetric = meterHandle.meter.createCounter('analyst.llm.cost_usd', { description: 'LLM cost in USD, per tenant (AC5: operations dashboard)' });

  // P4-10: AC1's own failure threshold / open duration are a deploy-
  // time config choice, not a magic number buried in worker.ts.
  const circuitBreaker = new CircuitBreaker({
    failureThreshold: Number(envOr('CIRCUIT_BREAKER_FAILURE_THRESHOLD', '5')),
    openDurationMs: Number(envOr('CIRCUIT_BREAKER_OPEN_DURATION_MS', '30000')),
  });
  const CIRCUIT_STATE_VALUE: Record<CircuitState, number> = { closed: 0, half_open: 1, open: 2 };
  // AC4: "degraded mode is visible in the dashboard" — a live gauge,
  // not a counter, since what matters is the CURRENT state, not how
  // many times it changed.
  meterHandle.meter
    .createObservableGauge('analyst.circuit_breaker.state', { description: '0=closed, 1=half_open, 2=open' })
    .addCallback((result) => result.observe(CIRCUIT_STATE_VALUE[circuitBreaker.getState()]));

  const pool = new Pool({ connectionString: envOr('POSTGRES_URL', 'postgres://sentinel:sentinel@localhost:5434/sentinel') });
  const brokers = envOr('REDPANDA_BROKERS', 'localhost:19092').split(',');
  const { consumer, producer, disconnect } = await createKafkaClients(brokers, envOr('CONSUMER_GROUP', 'analyst'));
  const ch = createTenantScopedClickHouseClient(envOr('CLICKHOUSE_URL', 'http://localhost:8123'));

  const apiKey = envOr('ANTHROPIC_API_KEY', '');
  if (!apiKey) {
    logger.error({}, 'ANTHROPIC_API_KEY is not set — the worker will start but every investigation will fail and route to DLQ');
  }
  const investigationModel = new AnthropicInvestigationModel({
    apiKey,
    model: envOr('ANTHROPIC_INVESTIGATION_MODEL', 'claude-opus-5'),
    maxTokens: Number(envOr('ANTHROPIC_MAX_TOKENS', '8192')),
    tools: { ch, pool, logger },
    groundingMetrics,
    cacheMetrics,
    costRecording: { pool, priceTable, costMetric },
    transcriptRecorder: new PostgresTranscriptRecorder(pool),
  });
  // AC4: the triage model identifier is its own configuration knob,
  // independent of the investigation model's — the whole point of this
  // ticket is that these are two DIFFERENT models (cheap vs expensive).
  const triageModel = new AnthropicTriageModel({
    apiKey,
    model: envOr('ANTHROPIC_TRIAGE_MODEL', 'claude-haiku-4-5-20251001'),
    cacheMetrics,
    costRecording: { pool, priceTable, costMetric },
  });

  const worker = new AnalystWorker({
    consumer,
    producer,
    pool,
    investigationModel,
    triageModel,
    logger,
    concurrencyPerTenant: Number(envOr('CONCURRENCY_PER_TENANT', '5')),
    partitionsConsumedConcurrently: Number(envOr('PARTITIONS_CONSUMED_CONCURRENTLY', '16')),
    retry: { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 10_000 },
    isRetryable: isRetryableAnthropicError,
    circuitBreaker,
    isProviderFailure: isRetryableAnthropicError,
  });

  await worker.start();
  logger.info({}, 'analyst worker started');

  // P4-11 AC3: "subject to retention policy" — a fixed daily sweep,
  // the same `setInterval`-based shape this file's own dev-facing
  // periodic tasks use (mirrors cmd/correlate/main.go's own
  // time.NewTicker sweeps, translated to Node's timer API).
  const retentionDays = Number(envOr('TRANSCRIPT_RETENTION_DAYS', '90'));
  const purgeIntervalMs = Number(envOr('TRANSCRIPT_PURGE_INTERVAL_MS', String(24 * 60 * 60 * 1000)));
  const purgeTimer = setInterval(() => {
    purgeExpiredTranscripts(pool, retentionDays)
      .then((purged) => {
        if (purged > 0) logger.info({ purged, retention_days: retentionDays }, 'purged expired investigation transcripts');
      })
      .catch((err) => logger.error({ err: err instanceof Error ? err.message : String(err) }, 'purging expired investigation transcripts failed'));
  }, purgeIntervalMs);

  // P4-12 AC2: "a daily digest per tenant" — the previous UTC day's
  // own dismissals, swept once every 24h, same timer shape as the
  // retention purge above.
  const digestIntervalMs = Number(envOr('DISMISSAL_DIGEST_INTERVAL_MS', String(24 * 60 * 60 * 1000)));
  const digestTimer = setInterval(() => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    generateDailyDigests(pool, yesterday, logger).catch((err) =>
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'generating daily dismissal digests failed'),
    );
  }, digestIntervalMs);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'draining in-flight investigations before exit');
    clearInterval(purgeTimer);
    clearInterval(digestTimer);
    await worker.stop();
    await disconnect();
    await ch.close();
    await pool.end();
    await meterHandle.shutdown();
    await tracingHandle.shutdown();
    logger.info({}, 'analyst worker stopped');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('analyst worker failed to start:', err);
  process.exit(1);
});

export { PermanentError };
