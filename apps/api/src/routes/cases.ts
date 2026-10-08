/**
 * P6-02: the dashboard's main working surface. `CasesRepository.list()`
 * and `.filterOptions()` (packages/db) do the real query work; this is
 * just the HTTP surface and input validation over them.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';
import { CasesRepository, type CaseListFilters } from '@sentinel/db';
import { requireRole } from '../auth/rbac.js';

export interface CasesRoutesOptions {
  pool: Pool;
}

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);
const VALID_STATES = new Set(['open', 'triaging', 'investigating', 'awaiting_approval', 'actioned', 'closed', 'dismissed']);
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

function parseIsoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return Number.isNaN(new Date(value).getTime()) ? undefined : value;
}

async function casesRoutesImpl(fastify: FastifyInstance, options: CasesRoutesOptions): Promise<void> {
  const { pool } = options;

  // AC1/read access: any authenticated member of the tenant, same bar
  // every other case-adjacent GET route in this file's siblings sets
  // (dismissals.ts, suppressions.ts) — read_only means exactly that,
  // read access, not "can't see the cases."
  fastify.get('/cases', { preHandler: requireRole('read_only') }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;

    if (typeof query.severity === 'string' && query.severity.length > 0 && !VALID_SEVERITIES.has(query.severity)) {
      return reply.code(400).send({ error: 'invalid_severity' });
    }
    if (typeof query.state === 'string' && query.state.length > 0 && !VALID_STATES.has(query.state)) {
      return reply.code(400).send({ error: 'invalid_state' });
    }

    const filters: CaseListFilters = {
      severity: typeof query.severity === 'string' && query.severity.length > 0 ? query.severity : undefined,
      state: typeof query.state === 'string' && query.state.length > 0 ? query.state : undefined,
      entityId: typeof query.entityId === 'string' && query.entityId.length > 0 ? query.entityId : undefined,
      ruleId: typeof query.ruleId === 'string' && query.ruleId.length > 0 ? query.ruleId : undefined,
      createdAfter: parseIsoDate(query.createdAfter),
      createdBefore: parseIsoDate(query.createdBefore),
    };

    const page = Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(String(query.pageSize ?? String(DEFAULT_PAGE_SIZE)), 10) || DEFAULT_PAGE_SIZE));

    const repo = new CasesRepository(pool);
    const result = await repo.list(filters, page, pageSize);

    return reply.code(200).send({ items: result.items, total: result.total, page, pageSize });
  });

  // Filter dropdown data — separate from the list response itself since
  // it changes far less often (new entities/rules appear slowly) and
  // every filter change the user makes would otherwise re-fetch it for
  // no reason.
  fastify.get('/cases/filter-options', { preHandler: requireRole('read_only') }, async (_request, reply) => {
    const repo = new CasesRepository(pool);
    const options = await repo.filterOptions();
    return reply.code(200).send(options);
  });
}

export const casesRoutes = fp(casesRoutesImpl, { name: 'sentinel-cases' });
