/**
 * P6-10 AC5: "an operations view shows margin per tenant" — gated
 * identically to hotfix-rules.ts's own `PLATFORM_OPS_TENANT_ID`
 * pattern (see that file's own doc comment for the full rationale):
 * a margin-per-tenant view inherently spans every customer, so
 * `requireRole('admin')` alone is not enough — it only proves admin of
 * WHATEVER tenant the caller's own session belongs to. The caller must
 * additionally be acting as Sentinel's own designated operations
 * tenant.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';
import { listTenantUsageSummaries } from '@sentinel/db';
import { computeMargin } from '@sentinel/billing';
import { roleAtLeast } from '../auth/rbac.js';

export interface OpsRoutesOptions {
  pool: Pool;
  /** See hotfix-rules.ts's own doc comment — undefined means every
   * request here is refused with 503, not a crash. */
  opsTenantId?: string | undefined;
}

async function opsRoutesImpl(fastify: FastifyInstance, options: OpsRoutesOptions): Promise<void> {
  const { pool, opsTenantId } = options;

  fastify.get('/ops/margin', async (request, reply) => {
    const session = request.session!; // tenantContextPlugin's onRequest hook already guarantees this

    if (!opsTenantId) {
      return reply.code(503).send({ error: 'ops_not_configured' });
    }
    if (!(roleAtLeast(session.role, 'admin') && session.tenantId === opsTenantId)) {
      return reply.code(403).send({ error: 'not_platform_operations_tenant' });
    }

    const summaries = await listTenantUsageSummaries(pool);
    const tenants = summaries.map((s) => ({
      tenantId: s.tenantId,
      name: s.name,
      plan: s.plan,
      seatCount: s.seatCount,
      eventVolume: s.eventVolume,
      seatsStatus: s.seatsStatus,
      eventVolumeStatus: s.eventVolumeStatus,
      costStatus: s.costStatus,
      ...computeMargin(s.plan, s.costUsd),
    }));

    return reply.code(200).send({ tenants });
  });
}

export const opsRoutes = fp(opsRoutesImpl, { name: 'sentinel-ops-routes' });
