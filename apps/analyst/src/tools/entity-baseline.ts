/**
 * get_entity_baseline (P4-02 AC1) — reads sentinel.entity_baselines
 * (ClickHouse, db/clickhouse/0001_events.sql + 0004) and evaluates it the
 * same way services/correlate/internal/baseline/baseline.go does.
 *
 * baseline.go's own package doc says this plainly: "this is deliberately
 * the future get_entity_baseline(entity, metric) investigation tool...
 * this package's job is to be the correct, well-documented function a
 * later phase wires in, not to build that framework itself." There is no
 * RPC between services/correlate (Go) and apps/analyst (TypeScript) —
 * every service that touches ClickHouse connects to it directly — so this
 * file is a deliberate, narrow port of that Go file's pure `evaluate`
 * logic and its store's query shape, not a reimplementation from
 * first principles. Metric names, Window, and MinObservations are kept
 * byte-for-byte identical so a baseline looks the same regardless of
 * which language asked for it.
 */
import type { ClickHouseClient } from '@clickhouse/client';
import { queryAsTenant } from '../clickhouse.js';
import { ToolInvalidArgumentError, runTool, type ToolOutcome, type Logger } from './types.js';

export const METRICS = ['country', 'asn', 'device', 'sign_in_hour', 'data_volume'] as const;
export type Metric = (typeof METRICS)[number];

/** services/correlate/internal/baseline/baseline.go's own Window. */
export const WINDOW_DAYS = 30;
/** services/correlate/internal/baseline/baseline.go's own MinObservations. */
export const MIN_OBSERVATIONS = 20;

export const DEFAULT_TIMEOUT_MS = 5_000;

export interface VolumeStats {
  p50: number;
  p95: number;
  p99: number;
}

export interface Baseline {
  metric: Metric;
  observations: number;
  /** false when observations < MIN_OBSERVATIONS — never treated as
   * anomalous by default when there isn't enough history to know. */
  valid: boolean;
  usualValues: string[];
  volume: VolumeStats | null;
}

export interface GetEntityBaselineArgs {
  entityId: string;
  metric: Metric;
}

interface RawAggregate {
  observations: number;
  topValues: string[];
  quantiles: number[];
}

function validate(args: GetEntityBaselineArgs): void {
  if (!args.entityId || typeof args.entityId !== 'string') {
    throw new ToolInvalidArgumentError('get_entity_baseline: entityId is required');
  }
  if (!(METRICS as readonly string[]).includes(args.metric)) {
    throw new ToolInvalidArgumentError(`get_entity_baseline: metric must be one of ${METRICS.join(', ')}`);
  }
}

/** The direct port of baseline.go's own `evaluate` — pure, no I/O, same
 * MinObservations floor applied in the same one place. */
export function evaluate(metric: Metric, raw: RawAggregate): Baseline {
  const b: Baseline = { metric, observations: raw.observations, valid: false, usualValues: [], volume: null };
  if (raw.observations < MIN_OBSERVATIONS) return b;
  b.valid = true;
  if (metric === 'data_volume') {
    if (raw.quantiles.length === 3) {
      b.volume = { p50: raw.quantiles[0]!, p95: raw.quantiles[1]!, p99: raw.quantiles[2]! };
    }
    return b;
  }
  b.usualValues = raw.topValues;
  return b;
}

async function readAggregate(
  ch: ClickHouseClient,
  tenantId: string,
  entityId: string,
  metric: Metric,
  signal: AbortSignal,
): Promise<RawAggregate> {
  if (metric === 'data_volume') {
    const rows = await queryAsTenant<{ observations: string; quantiles: number[] }>(ch, {
      tenantId,
      abortSignal: signal,
      query: `
        SELECT sum(finalizeAggregation(observations)) AS observations,
               quantilesTDigestMerge(0.5, 0.95, 0.99)(volume_quantiles) AS quantiles
        FROM sentinel.entity_baselines
        WHERE tenant_id = {tenantId:UUID} AND entity_id = {entityId:String}
          AND metric = {metric:String} AND bucket >= today() - {window:UInt32}
      `,
      query_params: { tenantId, entityId, metric, window: WINDOW_DAYS },
    });
    const row = rows[0];
    return { observations: Number(row?.observations ?? 0), topValues: [], quantiles: row?.quantiles ?? [] };
  }

  const rows = await queryAsTenant<{ observations: string; top_values: string[] }>(ch, {
    tenantId,
    abortSignal: signal,
    query: `
      SELECT sum(finalizeAggregation(observations)) AS observations,
             topKMerge(10)(value_counts) AS top_values
      FROM sentinel.entity_baselines
      WHERE tenant_id = {tenantId:UUID} AND entity_id = {entityId:String}
        AND metric = {metric:String} AND bucket >= today() - {window:UInt32}
    `,
    query_params: { tenantId, entityId, metric, window: WINDOW_DAYS },
  });
  const row = rows[0];
  return { observations: Number(row?.observations ?? 0), topValues: row?.top_values ?? [], quantiles: [] };
}

export async function getEntityBaseline(
  ch: ClickHouseClient,
  tenantId: string,
  args: GetEntityBaselineArgs,
  logger: Logger,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ToolOutcome<Baseline>> {
  return runTool({
    name: 'get_entity_baseline',
    tenantId,
    args,
    timeoutMs,
    logger,
    fn: async (signal) => {
      validate(args);
      const raw = await readAggregate(ch, tenantId, args.entityId, args.metric, signal);
      return evaluate(args.metric, raw);
    },
  });
}
