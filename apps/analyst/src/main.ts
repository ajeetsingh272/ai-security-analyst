/**
 * The analyst worker's real entrypoint (P4-01) — wires real Kafka,
 * real Postgres, a real (or absent) Anthropic client, starts
 * tracing, and drains in-flight work on SIGINT/SIGTERM before
 * exiting. Mirrors cmd/correlate/main.go's own graceful-shutdown
 * shape (services/correlate), translated to Node's signal API.
 */
import { Pool } from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { createLogger, startTracing } from '@sentinel/observability';
import { createKafkaClients } from './kafka.js';
import { AnalystWorker } from './worker.js';
import { AnthropicInvestigationModel } from './investigation-model.js';
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

  const pool = new Pool({ connectionString: envOr('POSTGRES_URL', 'postgres://sentinel:sentinel@localhost:5434/sentinel') });
  const brokers = envOr('REDPANDA_BROKERS', 'localhost:19092').split(',');
  const { consumer, producer, disconnect } = createKafkaClients(brokers, envOr('CONSUMER_GROUP', 'analyst'));

  const apiKey = envOr('ANTHROPIC_API_KEY', '');
  if (!apiKey) {
    logger.error({}, 'ANTHROPIC_API_KEY is not set — the worker will start but every investigation will fail and route to DLQ');
  }
  const investigationModel = new AnthropicInvestigationModel({
    apiKey,
    model: envOr('ANTHROPIC_INVESTIGATION_MODEL', 'claude-opus-5'),
    maxTokens: Number(envOr('ANTHROPIC_MAX_TOKENS', '8192')),
  });

  const worker = new AnalystWorker({
    consumer,
    producer,
    pool,
    investigationModel,
    logger,
    concurrencyPerTenant: Number(envOr('CONCURRENCY_PER_TENANT', '5')),
    partitionsConsumedConcurrently: Number(envOr('PARTITIONS_CONSUMED_CONCURRENTLY', '16')),
    retry: { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 10_000 },
    isRetryable: isRetryableAnthropicError,
  });

  await worker.start();
  logger.info({}, 'analyst worker started');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'draining in-flight investigations before exit');
    await worker.stop();
    await disconnect();
    await pool.end();
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
