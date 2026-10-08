/**
 * P6-12 AC: "a pilot dashboard shows progress against each success
 * criterion" — gated identically to ops.ts's own
 * `PLATFORM_OPS_TENANT_ID` pattern (see that file's own doc comment
 * for the full rationale): this view inherently spans every tenant,
 * so `requireRole('admin')` alone is not enough — it only proves
 * admin of WHATEVER tenant the caller's own session belongs to.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';
import { listOnboardingFunnelSummaries } from '@sentinel/db';
import { roleAtLeast } from '../auth/rbac.js';

export interface PilotRoutesOptions {
  pool: Pool;
  /** See hotfix-rules.ts's own doc comment — undefined means every
   * request here is refused with 503, not a crash. */
  opsTenantId?: string | undefined;
}

async function pilotRoutesImpl(fastify: FastifyInstance, options: PilotRoutesOptions): Promise<void> {
  const { pool, opsTenantId } = options;

  fastify.get('/ops/pilot', async (request, reply) => {
    const session = request.session!; // tenantContextPlugin's onRequest hook already guarantees this

    if (!opsTenantId) {
      return reply.code(503).send({ error: 'ops_not_configured' });
    }
    if (!(roleAtLeast(session.role, 'admin') && session.tenantId === opsTenantId)) {
      return reply.code(403).send({ error: 'not_platform_operations_tenant' });
    }

    const tenants = await listOnboardingFunnelSummaries(pool);
    return reply.code(200).send({ tenants });
  });
}

export const pilotRoutes = fp(pilotRoutesImpl, { name: 'sentinel-pilot-routes' });
