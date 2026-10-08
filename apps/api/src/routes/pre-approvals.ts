/**
 * P5-06: a tenant's own opt-in, per-playbook, into automatic execution
 * (the brief's own "their choice, their control"). `requireRole('admin')`
 * on every write — this changes whether a destructive-adjacent action
 * can run with no human in the loop at all, a materially bigger step
 * than suppressions.ts's own `analyst` bar for silencing a noisy rule.
 *
 * No manual `withTenantContext` here, unlike approvals.ts/
 * whatsapp-webhook.ts — those are PUBLIC routes with no session, so
 * tenantContextPlugin's own onRequest hook skips them and they must
 * establish context themselves from a token. This route has a real
 * session, so that hook has ALREADY called `enterTenantContext`
 * ambiently by the time this handler runs (same as suppressions.ts).
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';
import { PreApprovalRepository, DestructivePlaybookCannotBePreApprovedError } from '@sentinel/db';
import { requireRole } from '../auth/rbac.js';

export interface PreApprovalsRoutesOptions {
  pool: Pool;
}

async function preApprovalsRoutesImpl(fastify: FastifyInstance, options: PreApprovalsRoutesOptions): Promise<void> {
  const { pool } = options;

  fastify.post<{ Params: { playbook: string } }>('/pre-approvals/:playbook', { preHandler: requireRole('admin') }, async (request, reply) => {
    const session = request.session!;
    try {
      await new PreApprovalRepository(pool).grant(request.params.playbook, session.userId);
    } catch (err) {
      if (err instanceof DestructivePlaybookCannotBePreApprovedError) {
        return reply.code(403).send({ error: 'destructive_playbook_cannot_be_pre_approved', message: err.message });
      }
      throw err;
    }
    return reply.code(200).send({ ok: true, playbook: request.params.playbook, preApproved: true });
  });

  fastify.delete<{ Params: { playbook: string } }>('/pre-approvals/:playbook', { preHandler: requireRole('admin') }, async (request, reply) => {
    const session = request.session!;
    const revoked = await new PreApprovalRepository(pool).revoke(request.params.playbook, session.userId);
    return reply.code(200).send({ ok: true, playbook: request.params.playbook, preApproved: false, wasActive: revoked });
  });

  fastify.get<{ Params: { playbook: string } }>('/pre-approvals/:playbook', { preHandler: requireRole('read_only') }, async (request, reply) => {
    const preApproved = await new PreApprovalRepository(pool).isPreApproved(request.params.playbook);
    return reply.code(200).send({ playbook: request.params.playbook, preApproved });
  });
}

export const preApprovalsRoutes = fp(preApprovalsRoutesImpl, { name: 'sentinel-pre-approvals-routes' });
