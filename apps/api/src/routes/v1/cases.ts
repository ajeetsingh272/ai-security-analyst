/**
 * P6-09: the public API's case endpoints — version 1
 * (docs/architecture/public-api.md). Reuses `CasesRepository` exactly
 * as the dashboard's own internal `routes/cases.ts` does; this file
 * only adds the public-contract JSON schema (for OpenAPI generation,
 * see ../../openapi.ts) and the `/v1` prefix, not a second
 * implementation of case listing.
 *
 * `requireRole('read_only')` is deliberately the ONLY bar here — v1 is
 * read-only across the board for now (see the versioning doc's own
 * "why no write endpoints yet" note); an API key's 'write' scope maps
 * to a role capable of more than this file ever checks for, so nothing
 * here is weakened by that scope existing.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';
import { CasesRepository } from '@sentinel/db';
import { requireRole } from '../../auth/rbac.js';

export interface V1CasesRoutesOptions {
  pool: Pool;
}

const CASE_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', format: 'uuid' },
    severity: { type: ['string', 'null'], enum: ['critical', 'high', 'medium', 'low', 'info', null] },
    title: { type: ['string', 'null'] },
    score: { type: ['number', 'null'] },
    state: { type: ['string', 'null'] },
    entityIds: { type: 'array', items: { type: 'string' } },
    signalCount: { type: 'number' },
    createdAt: { type: 'string', format: 'date-time' },
    windowStart: { type: 'string', format: 'date-time' },
    windowEnd: { type: ['string', 'null'], format: 'date-time' },
  },
  required: ['id', 'tenantId', 'severity', 'title', 'score', 'state', 'entityIds', 'signalCount', 'createdAt', 'windowStart', 'windowEnd'],
} as const;

async function v1CasesRoutesImpl(fastify: FastifyInstance, options: V1CasesRoutesOptions): Promise<void> {
  const { pool } = options;

  fastify.get(
    '/v1/cases',
    {
      preHandler: requireRole('read_only'),
      schema: {
        tags: ['v1'],
        summary: 'List cases for the authenticated tenant',
        querystring: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
            state: { type: 'string' },
            createdAfter: { type: 'string', format: 'date-time' },
            createdBefore: { type: 'string', format: 'date-time' },
            page: { type: 'integer', minimum: 1, default: 1 },
            pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              items: { type: 'array', items: CASE_ITEM_SCHEMA },
              total: { type: 'number' },
              page: { type: 'number' },
              pageSize: { type: 'number' },
            },
            required: ['items', 'total', 'page', 'pageSize'],
          },
        },
      },
    },
    async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const page = Math.max(1, Number.parseInt(String(query['page'] ?? '1'), 10) || 1);
      const pageSize = Math.min(100, Math.max(1, Number.parseInt(String(query['pageSize'] ?? '25'), 10) || 25));

      const repo = new CasesRepository(pool);
      const result = await repo.list(
        {
          severity: typeof query['severity'] === 'string' ? query['severity'] : undefined,
          state: typeof query['state'] === 'string' ? query['state'] : undefined,
          createdAfter: typeof query['createdAfter'] === 'string' ? query['createdAfter'] : undefined,
          createdBefore: typeof query['createdBefore'] === 'string' ? query['createdBefore'] : undefined,
        },
        page,
        pageSize,
      );

      return reply.code(200).send({ items: result.items, total: result.total, page, pageSize });
    },
  );

  fastify.get(
    '/v1/cases/:id',
    {
      preHandler: requireRole('read_only'),
      schema: {
        tags: ['v1'],
        summary: 'Get a single case by id',
        params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
        response: {
          200: {
            type: 'object',
            properties: { id: { type: 'string' }, tenantId: { type: 'string' }, severity: { type: ['string', 'null'] }, title: { type: ['string', 'null'] }, signalCount: { type: 'number' }, createdAt: { type: 'string' }, windowStart: { type: 'string' }, windowEnd: { type: ['string', 'null'] } },
            required: ['id', 'tenantId', 'severity', 'title', 'signalCount', 'createdAt', 'windowStart', 'windowEnd'],
          },
          404: { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const repo = new CasesRepository(pool);
      const found = await repo.findById(id);
      if (!found) return reply.code(404).send({ error: 'not_found' });
      return reply.code(200).send(found);
    },
  );
}

export const v1CasesRoutes = fp(v1CasesRoutesImpl, { name: 'sentinel-v1-cases-routes' });
