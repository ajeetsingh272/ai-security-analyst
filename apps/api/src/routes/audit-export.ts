/**
 * P5-09 AC5/T4: "an audit export for a tenant and date range is
 * available for compliance." `requireRole('admin')` — an export of
 * every alert/approval/execution decision for a date range is
 * materially more sensitive than suppressions.ts's own `analyst` bar,
 * the same reasoning pre-approvals.ts already applies.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';
import { AuditExportRepository } from '@sentinel/db';
import { requireRole } from '../auth/rbac.js';

export interface AuditExportRoutesOptions {
  pool: Pool;
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

async function auditExportRoutesImpl(fastify: FastifyInstance, options: AuditExportRoutesOptions): Promise<void> {
  const { pool } = options;

  fastify.get<{ Querystring: { from?: string; to?: string } }>('/audit/export', { preHandler: requireRole('admin') }, async (request, reply) => {
    const from = parseDate(request.query.from);
    const to = parseDate(request.query.to);
    if (!from || !to || from >= to) {
      return reply.code(400).send({ error: 'invalid_request', message: 'from and to must both be valid ISO dates, with from strictly before to.' });
    }

    const entries = await new AuditExportRepository(pool).exportRange(from, to);
    return reply.code(200).send({ from: from.toISOString(), to: to.toISOString(), count: entries.length, entries });
  });
}

export const auditExportRoutes = fp(auditExportRoutesImpl, { name: 'sentinel-audit-export-routes' });
