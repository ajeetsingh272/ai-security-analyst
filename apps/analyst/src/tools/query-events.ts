/**
 * query_events (P4-02 AC1): raw OCSF events from sentinel.events
 * (db/clickhouse/0001_events.sql) for one entity, newest first.
 *
 * `entityField` is never interpolated as free text — only one of a fixed
 * allow-list of real column names can be selected, the same discipline
 * services/correlate/internal/baseline/store.go's own `categoricalMetric.expr`
 * comment states ("a sentinel.events column/expression, never user input").
 * Every other value (entityId, sinceIso, untilIso) is a bound query
 * parameter, never string-built into the SQL text.
 */
import type { ClickHouseClient } from '@clickhouse/client';
import { queryAsTenant } from '../clickhouse.js';
import { truncate, ToolInvalidArgumentError, runTool, type ToolOutcome, type Logger } from './types.js';

const ENTITY_FIELDS = ['actor_user_uid', 'target_uid', 'device_uid', 'src_ip'] as const;
export type EntityField = (typeof ENTITY_FIELDS)[number];

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const DEFAULT_TIMEOUT_MS = 5_000;

export interface QueryEventsArgs {
  entityId: string;
  entityField?: EntityField;
  sinceIso?: string;
  untilIso?: string;
  limit?: number;
}

export interface EventRow {
  event_id: string;
  time: string;
  class_uid: number;
  category_uid: number;
  activity_id: number;
  severity_id: number;
  actor_user_uid: string;
  target_uid: string;
  src_ip: string;
  message: string;
}

export interface QueryEventsResult {
  events: EventRow[];
  truncated: boolean;
}

function validate(args: QueryEventsArgs): asserts args is QueryEventsArgs & { entityField: EntityField; limit: number } {
  if (!args.entityId || typeof args.entityId !== 'string') {
    throw new ToolInvalidArgumentError('query_events: entityId is required');
  }
  if (args.entityField !== undefined && !(ENTITY_FIELDS as readonly string[]).includes(args.entityField)) {
    throw new ToolInvalidArgumentError(`query_events: entityField must be one of ${ENTITY_FIELDS.join(', ')}`);
  }
}

export async function queryEvents(
  ch: ClickHouseClient,
  tenantId: string,
  args: QueryEventsArgs,
  logger: Logger,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ToolOutcome<QueryEventsResult>> {
  return runTool({
    name: 'query_events',
    tenantId,
    args,
    timeoutMs,
    logger,
    fn: async (signal) => {
      validate(args);
      const field = args.entityField ?? 'actor_user_uid';
      const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      // ClickHouse's DateTime64 text parser rejects ISO 8601's 'T'/'Z' —
      // it wants 'YYYY-MM-DD HH:MM:SS.sss', the same format seedEvents'
      // own insert already uses.
      const toChDateTime = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '');
      const since = args.sinceIso ? toChDateTime(new Date(args.sinceIso)) : toChDateTime(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
      const until = args.untilIso ? toChDateTime(new Date(args.untilIso)) : toChDateTime(new Date());

      // field is from ENTITY_FIELDS (validated above), never the raw
      // argument — safe to interpolate as a column name; everything else
      // is a bound {name:Type} parameter.
      const rows = await queryAsTenant<EventRow>(ch, {
        tenantId,
        abortSignal: signal,
        query: `
          SELECT event_id, time, class_uid, category_uid, activity_id, severity_id,
                 actor_user_uid, target_uid, src_ip, message
          FROM sentinel.events
          WHERE tenant_id = {tenantId:UUID}
            AND ${field} = {entityId:String}
            AND time >= {since:DateTime64(3)}
            AND time < {until:DateTime64(3)}
          ORDER BY time DESC
          LIMIT {limit:UInt32}
        `,
        query_params: { tenantId, entityId: args.entityId, since, until, limit: limit + 1 },
      });

      const { items, truncated } = truncate(rows, limit);
      return { events: items, truncated };
    },
  });
}
