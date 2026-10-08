/**
 * P6-07: the weekly owner report's HTTP surface — generate on demand,
 * list/read the dashboard copy, export the PDF, and the per-tenant
 * schedule setting. The actual weekly cadence (AC1's "on a
 * configurable schedule") is driven by server.ts's own timer calling
 * the same `generateWeeklyReport` this route's POST handler calls —
 * this file is not where the schedule is enforced, only where it's
 * configured and where an on-demand report can be requested.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';
import { WeeklyReportRepository, ReportScheduleRepository, withTenantContext } from '@sentinel/db';
import { requireRole } from '../auth/rbac.js';
import { generateWeeklyReport } from '../weekly-report.js';
import { renderWeeklyReportPdf } from '../weekly-report-render.js';
import { sendWeeklyReportEmail, type ResendConfig } from '../weekly-report-email.js';

export interface WeeklyReportRoutesOptions {
  pool: Pool;
  resendConfig?: ResendConfig | undefined;
}

async function weeklyReportRoutesImpl(fastify: FastifyInstance, options: WeeklyReportRoutesOptions): Promise<void> {
  const { pool, resendConfig } = options;

  fastify.post('/reports/weekly', { preHandler: requireRole('admin') }, async (request, reply) => {
    const session = request.session!;
    const report = await generateWeeklyReport(pool, session.tenantId, new Date());

    if (resendConfig) {
      await sendWeeklyReportEmail(pool, resendConfig, session.tenantId, report).catch((err) => {
        fastify.log.error({ err }, 'weekly report email send failed');
      });
    }

    return reply.code(200).send(report);
  });

  fastify.get('/reports/weekly', { preHandler: requireRole('read_only') }, async (request, reply) => {
    const session = request.session!;
    const reports = await withTenantContext(session.tenantId, () => new WeeklyReportRepository(pool).listForTenant(52));
    return reply.code(200).send({ reports });
  });

  fastify.get('/reports/weekly/:id', { preHandler: requireRole('read_only') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = request.session!;
    const report = await withTenantContext(session.tenantId, () => new WeeklyReportRepository(pool).findById(id));
    if (!report) return reply.code(404).send({ error: 'not_found' });
    return reply.code(200).send(report);
  });

  fastify.get('/reports/weekly/:id/pdf', { preHandler: requireRole('read_only') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = request.session!;
    const report = await withTenantContext(session.tenantId, () => new WeeklyReportRepository(pool).findById(id));
    if (!report) return reply.code(404).send({ error: 'not_found' });

    const tenantResult = await pool.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [session.tenantId]);
    const pdf = await renderWeeklyReportPdf(report, tenantResult.rows[0]?.name ?? 'Your tenant');

    reply.header('content-type', 'application/pdf');
    reply.header('content-disposition', `attachment; filename="weekly-report-${id}.pdf"`);
    return reply.send(pdf);
  });

  fastify.get('/reports/schedule', { preHandler: requireRole('admin') }, async (request, reply) => {
    const session = request.session!;
    const schedule = await withTenantContext(session.tenantId, () => new ReportScheduleRepository(pool).get());
    return reply.code(200).send(schedule);
  });

  fastify.patch<{ Body: { dayOfWeek?: number; enabled?: boolean } }>(
    '/reports/schedule',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const session = request.session!;
      const body = request.body ?? {};
      if (body.dayOfWeek !== undefined && (body.dayOfWeek < 0 || body.dayOfWeek > 6)) {
        return reply.code(400).send({ error: 'invalid_day_of_week' });
      }

      await withTenantContext(session.tenantId, async () => {
        const repo = new ReportScheduleRepository(pool);
        const current = await repo.get();
        await repo.upsert({
          dayOfWeek: body.dayOfWeek ?? current.dayOfWeek,
          enabled: body.enabled ?? current.enabled,
        });
      });

      const updated = await withTenantContext(session.tenantId, () => new ReportScheduleRepository(pool).get());
      return reply.code(200).send(updated);
    },
  );
}

export const weeklyReportRoutes = fp(weeklyReportRoutesImpl, { name: 'sentinel-weekly-report-routes' });
