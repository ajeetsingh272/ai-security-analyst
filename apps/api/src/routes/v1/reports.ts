/**
 * P6-09: the public API's weekly-report endpoint — version 1. Reuses
 * `WeeklyReportRepository` exactly as the dashboard's own internal
 * `routes/weekly-report.ts` does; see v1/cases.ts's own doc comment
 * for why this file only adds the public-contract schema, not a
 * second implementation.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';
import { WeeklyReportRepository, withTenantContext } from '@sentinel/db';
import { requireRole } from '../../auth/rbac.js';

export interface V1ReportsRoutesOptions {
  pool: Pool;
}

async function v1ReportsRoutesImpl(fastify: FastifyInstance, options: V1ReportsRoutesOptions): Promise<void> {
  const { pool } = options;

  fastify.get(
    '/v1/reports/weekly',
    {
      preHandler: requireRole('read_only'),
      schema: {
        tags: ['v1'],
        summary: 'List this tenant\'s weekly owner reports, most recent first',
        response: {
          200: {
            type: 'object',
            properties: {
              reports: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    windowStart: { type: 'string' },
                    windowEnd: { type: 'string' },
                    headline: { type: 'string' },
                    oneImprovement: { type: ['string', 'null'] },
                    isQuiet: { type: 'boolean' },
                    generatedAt: { type: 'string' },
                  },
                  required: ['id', 'windowStart', 'windowEnd', 'headline', 'oneImprovement', 'isQuiet', 'generatedAt'],
                },
              },
            },
            required: ['reports'],
          },
        },
      },
    },
    async (request, reply) => {
      const session = request.session!;
      const reports = await withTenantContext(session.tenantId, () => new WeeklyReportRepository(pool).listForTenant(52));
      return reply.code(200).send({
        reports: reports.map((r) => ({
          id: r.id,
          windowStart: r.windowStart,
          windowEnd: r.windowEnd,
          headline: r.headline,
          oneImprovement: r.oneImprovement,
          isQuiet: r.isQuiet,
          generatedAt: r.generatedAt,
        })),
      });
    },
  );
}

export const v1ReportsRoutes = fp(v1ReportsRoutesImpl, { name: 'sentinel-v1-reports-routes' });
