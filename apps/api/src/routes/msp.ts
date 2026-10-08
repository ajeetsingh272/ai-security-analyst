/**
 * P6-06: the MSP console's own backend — "every linked client's
 * posture, ranked by open critical cases, in one screen." Drilling
 * into a client reuses P6-01's existing session-authenticated
 * `POST /auth/switch-tenant` (built on P0-09's `canActAsTenant`) —
 * this route only ever lists what that switch is already allowed to
 * target, it does not reimplement the switch itself.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';
import { MspRepository, CasesRepository, withTenantContext } from '@sentinel/db';
import { requireRole } from '../auth/rbac.js';

export interface MspRoutesOptions {
  pool: Pool;
}

export interface MspClientSummary {
  tenantId: string;
  name: string;
  openCriticalCount: number;
}

async function mspRoutesImpl(fastify: FastifyInstance, options: MspRoutesOptions): Promise<void> {
  const { pool } = options;

  // admin, not read_only — seeing every linked client's own case
  // counts is cross-tenant visibility, a meaningfully elevated
  // capability compared to reading this tenant's own cases.
  fastify.get('/msp/clients', { preHandler: requireRole('admin') }, async (request, reply) => {
    const session = request.session!;

    const linked = await withTenantContext(session.tenantId, () => new MspRepository(pool).listLinkedClients());

    // T1/AC4: parallel, not sequential — each client's own count is an
    // independent short transaction under ITS OWN tenant context (this
    // schema has no cross-tenant-bypass role to do it in one query),
    // and the pool's own connection limit naturally throttles how many
    // run at once rather than this code needing to batch by hand.
    const summaries: MspClientSummary[] = await Promise.all(
      linked.map(async (client): Promise<MspClientSummary> => {
        const openCriticalCount = await withTenantContext(client.clientTenantId, () => new CasesRepository(pool).countOpenCritical());
        return { tenantId: client.clientTenantId, name: client.clientTenantName, openCriticalCount };
      }),
    );

    summaries.sort((a, b) => b.openCriticalCount - a.openCriticalCount);
    return reply.code(200).send({ clients: summaries });
  });
}

export const mspRoutes = fp(mspRoutesImpl, { name: 'sentinel-msp-routes' });
