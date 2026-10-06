/**
 * GET /connectors/health — P1-11 AC4 ("Connector health is visible through
 * the API for the dashboard to render") and T3 ("Health endpoint reflects
 * a revoked-consent connector as degraded").
 *
 * Runs after tenantContextPlugin's `onRequest` hook, so by the time this
 * handler executes `enterTenantContext` has already been called for this
 * request — ConnectorsRepository reads that ambient context at
 * construction time (TenantScopedRepository's own contract), so there is
 * nothing for this route to pass or validate itself; a request with no
 * valid tenant context never reaches here at all (401, from
 * tenantContextPlugin).
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';
import { ConnectorsRepository } from '@sentinel/db';
import { requireRole } from '../auth/rbac.js';

export interface ConnectorsRoutesOptions {
  pool: Pool;
}

async function connectorsRoutesImpl(
  fastify: FastifyInstance,
  options: ConnectorsRoutesOptions,
): Promise<void> {
  const { pool } = options;

  fastify.get(
    '/connectors/health',
    // P0-09 AC2 ("roles enforced server-side on every endpoint") still
    // applies even though every role can read this — read_only is the
    // lowest rank, so this is "any authenticated member of the tenant",
    // made explicit rather than left as an accidental side effect of no
    // check existing at all.
    { preHandler: requireRole('read_only') },
    async (_request, reply) => {
      const repo = new ConnectorsRepository(pool);
      const connectors = await repo.findHealth();
      return reply.code(200).send({ connectors });
    },
  );
}

export const connectorsRoutes = fp(connectorsRoutesImpl, { name: 'sentinel-connectors-routes' });
