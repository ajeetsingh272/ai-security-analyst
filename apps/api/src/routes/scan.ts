/**
 * P6-05: the free 7-day security scan. See 0024_scan_jobs.sql's own
 * doc comment for the honest scope boundary — this summarises whatever
 * cases already exist for the tenant within a fixed 7-day window, it
 * does not itself trigger go/sentinelreplay's historical re-ingestion.
 *
 * Funnel instrumentation (AC5/T4) is real `audit_log` entries, not a
 * Prometheus counter — this sandbox has no otel-collector to verify a
 * counter against, and audit_log is already this codebase's own
 * durable "this happened, to this tenant, at this time" ledger for
 * every other feature (every P5 approval/notification/audit ticket).
 * Reusing it here means the funnel is queryable with real SQL, not an
 * unverifiable side channel.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';
import { CasesRepository, ScanJobsRepository, AuditLogWriter, withTenantContext, type CaseListItem } from '@sentinel/db';
import { requireRole } from '../auth/rbac.js';

export interface ScanRoutesOptions {
  pool: Pool;
}

const SCAN_WINDOW_DAYS = 7;
const MAX_FINDINGS = 10_000; // P6-02's own proven scale (cases-repository-load.integration.test.ts)

export interface ScanSummary {
  scanId: string;
  windowStart: string;
  windowEnd: string;
  totalFindings: number;
  entitiesAffected: number;
  isClean: boolean;
  headline: string;
  topFinding: { title: string | null; severity: string | null } | null;
  findings: CaseListItem[];
}

const SERIOUS_SEVERITIES = new Set(['critical', 'high', 'medium']);

async function summarize(pool: Pool, scanId: string, windowStart: string, windowEnd: string): Promise<ScanSummary> {
  const page = await new CasesRepository(pool).list({ createdAfter: windowStart, createdBefore: windowEnd }, 1, MAX_FINDINGS);
  const serious = page.items.filter((c) => c.severity && SERIOUS_SEVERITIES.has(c.severity));
  const entitiesAffected = new Set(page.items.flatMap((c) => c.entityIds)).size;
  const isClean = serious.length === 0;

  const headline = isClean
    ? page.items.length === 0
      ? 'Nothing serious found this week.'
      : `Nothing serious found this week — ${page.items.length} low-priority item${page.items.length === 1 ? '' : 's'} noted, nothing that needs action.`
    : `We found ${serious.length} thing${serious.length === 1 ? '' : 's'} that need${serious.length === 1 ? 's' : ''} your attention, affecting ${entitiesAffected} ${entitiesAffected === 1 ? 'person' : 'people'}.`;

  return {
    scanId,
    windowStart,
    windowEnd,
    totalFindings: page.items.length,
    entitiesAffected,
    isClean,
    headline,
    topFinding: page.items[0] ? { title: page.items[0].title, severity: page.items[0].severity } : null,
    findings: page.items,
  };
}

async function scanRoutesImpl(fastify: FastifyInstance, options: ScanRoutesOptions): Promise<void> {
  const { pool } = options;

  // AC1's own entry point — admin, same bar connecting a connector sets
  // (routes/m365-connector.ts), since starting a scan is an equally
  // meaningful tenant-wide action, not a routine read.
  fastify.post('/scan', { preHandler: requireRole('admin') }, async (request, reply) => {
    const session = request.session!;
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const job = await withTenantContext(session.tenantId, async () => {
      const created = await new ScanJobsRepository(pool).create(windowStart, windowEnd, session.userId);
      await new AuditLogWriter(pool).insert({
        actorType: 'human',
        actorId: session.userId,
        action: 'scan.started',
        subjectType: 'scan_job',
        subjectId: created.id,
        payload: { windowStart: created.windowStart, windowEnd: created.windowEnd },
      });
      await new AuditLogWriter(pool).insert({
        actorType: 'system',
        actorId: 'scan',
        action: 'scan.completed',
        subjectType: 'scan_job',
        subjectId: created.id,
        payload: {},
      });
      return created;
    });

    const summary = await withTenantContext(session.tenantId, () => summarize(pool, job.id, job.windowStart, job.windowEnd));
    return reply.code(200).send(summary);
  });

  fastify.get('/scan/:id', { preHandler: requireRole('read_only') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = request.session!;

    const result = await withTenantContext(session.tenantId, async () => {
      const job = await new ScanJobsRepository(pool).findById(id);
      if (!job) return null;
      await new AuditLogWriter(pool).insert({
        actorType: 'human',
        actorId: session.userId,
        action: 'scan.viewed',
        subjectType: 'scan_job',
        subjectId: id,
        payload: {},
      });
      return summarize(pool, job.id, job.windowStart, job.windowEnd);
    });

    if (!result) return reply.code(404).send({ error: 'not_found' });
    return reply.code(200).send(result);
  });

  // AC3's own "forward internally" — a lightweight signal that someone
  // actually used the share control, distinct from merely viewing the
  // report themselves.
  fastify.post('/scan/:id/share', { preHandler: requireRole('read_only') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = request.session!;

    const job = await withTenantContext(session.tenantId, () => new ScanJobsRepository(pool).findById(id));
    if (!job) return reply.code(404).send({ error: 'not_found' });

    await withTenantContext(session.tenantId, () =>
      new AuditLogWriter(pool).insert({
        actorType: 'human',
        actorId: session.userId,
        action: 'scan.report_shared',
        subjectType: 'scan_job',
        subjectId: id,
        payload: {},
      }),
    );
    return reply.code(200).send({ ok: true });
  });
}

export const scanRoutes = fp(scanRoutesImpl, { name: 'sentinel-scan-routes' });
