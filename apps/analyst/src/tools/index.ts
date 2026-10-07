/**
 * The investigation tool registry (P4-02): the four tools' Anthropic
 * tool-use JSON schemas (what the model sees — no `tenantId` parameter
 * anywhere in any of them, AC2) plus a single dispatch function
 * `executeTool` that `investigation-model.ts`'s tool-use loop calls by
 * name. `tenantId` is threaded through from the worker's own trusted
 * `CaseContext`, never read from the model's tool-call arguments.
 */
import type { ClickHouseClient } from '@clickhouse/client';
import type { Pool } from 'pg';
import type Anthropic from '@anthropic-ai/sdk';
import type { Logger } from './types.js';
import { queryEvents, type QueryEventsArgs } from './query-events.js';
import { getEntityBaseline, METRICS, type GetEntityBaselineArgs } from './entity-baseline.js';
import { lookupThreatIntel, type LookupThreatIntelArgs } from './threat-intel.js';
import { getCaseHistory, type GetCaseHistoryArgs } from './case-history.js';

export interface ToolDependencies {
  ch: ClickHouseClient;
  pool: Pool;
  logger: Logger;
}

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: 'query_events',
    description: "Query raw security events for one entity (a user, device, or IP), newest first. Bounded to this case's own tenant.",
    input_schema: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'The entity identifier to query events for.' },
        entityField: { type: 'string', enum: ['actor_user_uid', 'target_uid', 'device_uid', 'src_ip'], description: 'Which column entityId matches. Defaults to actor_user_uid.' },
        sinceIso: { type: 'string', description: 'ISO 8601 timestamp; defaults to 30 days ago.' },
        untilIso: { type: 'string', description: 'ISO 8601 timestamp; defaults to now.' },
        limit: { type: 'integer', description: 'Max rows to return, capped at 200. Defaults to 50.' },
      },
      required: ['entityId'],
    },
  },
  {
    name: 'get_entity_baseline',
    description: "Get an entity's behavioural baseline (usual countries, ASNs, devices, sign-in hours, or typical data-transfer volume) over a rolling 30-day window.",
    input_schema: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'The entity identifier.' },
        metric: { type: 'string', enum: [...METRICS], description: 'Which baseline dimension to read.' },
      },
      required: ['entityId', 'metric'],
    },
  },
  {
    name: 'lookup_threat_intel',
    description: 'Look up a threat-intel indicator (IP, domain, hash, or email). May report that no threat-intel source is configured.',
    input_schema: {
      type: 'object',
      properties: {
        indicator: { type: 'string', description: 'The indicator value.' },
        indicatorType: { type: 'string', enum: ['ip', 'domain', 'hash', 'email'] },
      },
      required: ['indicator', 'indicatorType'],
    },
  },
  {
    name: 'get_case_history',
    description: "Get a case's full signal and transition history, newest first.",
    input_schema: {
      type: 'object',
      properties: {
        caseId: { type: 'string', description: 'The case id.' },
        limit: { type: 'integer', description: 'Max rows per list, capped at 200. Defaults to 50.' },
      },
      required: ['caseId'],
    },
  },
];

export class UnknownToolError extends Error {
  constructor(name: string) {
    super(`unknown investigation tool: ${name}`);
    this.name = 'UnknownToolError';
  }
}

export async function executeTool(name: string, tenantId: string, args: unknown, deps: ToolDependencies): Promise<unknown> {
  switch (name) {
    case 'query_events':
      return queryEvents(deps.ch, tenantId, args as QueryEventsArgs, deps.logger);
    case 'get_entity_baseline':
      return getEntityBaseline(deps.ch, tenantId, args as GetEntityBaselineArgs, deps.logger);
    case 'lookup_threat_intel':
      return lookupThreatIntel(tenantId, args as LookupThreatIntelArgs, deps.logger);
    case 'get_case_history':
      return getCaseHistory(deps.pool, tenantId, args as GetCaseHistoryArgs, deps.logger);
    default:
      throw new UnknownToolError(name);
  }
}
