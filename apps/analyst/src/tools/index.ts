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
import { scanValueForInjectionAttempts, wrapUntrustedData } from '../injection-defense.js';

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

/** P4-09 AC4: a well-formed tool call never includes an identifier for
 * who it's acting on behalf of at all (AC2's own design) — any of
 * these keys showing up in the model's own `args` is either a client
 * bug or an attempt to inject a tenant id, and either way must have
 * ZERO effect, since every tool below reads `tenantId` only from this
 * function's own second parameter, never from `args`. */
const SUSPICIOUS_ARG_KEYS = ['tenantId', 'tenant_id', 'tenantID'];

function detectSuspiciousArgKeys(args: unknown): string[] {
  if (typeof args !== 'object' || args === null) return [];
  return SUSPICIOUS_ARG_KEYS.filter((k) => k in (args as Record<string, unknown>));
}

export interface ToolExecutionOutcome {
  /** Already wrapped as untrusted data (P4-09 AC1) — ready to use
   * verbatim as a `tool_result` block's own `content`. */
  content: string;
  injectionDetected: boolean;
}

export async function executeTool(name: string, tenantId: string, args: unknown, deps: ToolDependencies): Promise<ToolExecutionOutcome> {
  const suspiciousKeys = detectSuspiciousArgKeys(args);
  if (suspiciousKeys.length > 0) {
    deps.logger.warn(
      { tool: name, tenantId, args, suspicious_arg_keys: suspiciousKeys },
      'tool call arguments included a tenant-identifying key, which this tool never reads — possible injection attempt or client bug',
    );
  }

  let result: unknown;
  switch (name) {
    case 'query_events':
      result = await queryEvents(deps.ch, tenantId, args as QueryEventsArgs, deps.logger);
      break;
    case 'get_entity_baseline':
      result = await getEntityBaseline(deps.ch, tenantId, args as GetEntityBaselineArgs, deps.logger);
      break;
    case 'lookup_threat_intel':
      result = await lookupThreatIntel(tenantId, args as LookupThreatIntelArgs, deps.logger);
      break;
    case 'get_case_history':
      result = await getCaseHistory(deps.pool, tenantId, args as GetCaseHistoryArgs, deps.logger);
      break;
    default:
      throw new UnknownToolError(name);
  }

  // P4-09 AC3/AC5: scanned here, not only at the point of use, so
  // every tool's result is checked the same way regardless of which
  // one surfaced the attacker-controlled field.
  const injectionPatterns = scanValueForInjectionAttempts(result);
  const injectionDetected = injectionPatterns.length > 0;
  if (injectionDetected) {
    deps.logger.warn(
      { tool: name, tenantId, injection_patterns: injectionPatterns },
      'possible prompt-injection attempt detected in tool result content',
    );
  }

  return { content: wrapUntrustedData(`tool_result:${name}`, JSON.stringify(result), injectionDetected), injectionDetected };
}
