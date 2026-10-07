/**
 * P2-10 (TG3: "Nothing is hidden — dismissals are surfaced"). Lets an
 * analyst suppress a noisy rule (optionally scoped to one entity) with a
 * mandatory reason and a bounded lifetime.
 *
 * `requireRole('analyst')` on every write — suppressing a detection changes
 * what an analyst sees, which is a step up from merely reading data
 * (read_only). Reading the active list stays at read_only, same rationale
 * as GET /connectors/health: any authenticated member of the tenant.
 *
 * Every write is also an audit-logged action (ADR-0007/TG6) — "who, when,
 * why" is the whole point of this ticket, and the audit log is already the
 * place that answers that question for every other write in this API.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';
import { AuditLogWriter, SuppressionEmptyReasonError, SuppressionsRepository } from '@sentinel/db';
import { requireRole } from '../auth/rbac.js';

export interface SuppressionsRoutesOptions {
  pool: Pool;
}

const DEFAULT_EXPIRES_IN_DAYS = 30;
const MAX_EXPIRES_IN_DAYS = 90;

function parseExpiresInDays(value: unknown): number | null {
  if (value === undefined) return DEFAULT_EXPIRES_IN_DAYS;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_EXPIRES_IN_DAYS) {
    return null;
  }
  return value;
}

function expiresAtFromDays(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function suppressionsRoutesImpl(
  fastify: FastifyInstance,
  options: SuppressionsRoutesOptions,
): Promise<void> {
  const { pool } = options;

  fastify.post('/suppressions', { preHandler: requireRole('analyst') }, async (request, reply) => {
    const session = request.session!;
    const body = request.body as {
      ruleId?: unknown;
      entityId?: unknown;
      reason?: unknown;
      expiresInDays?: unknown;
    };

    if (typeof body.ruleId !== 'string' || body.ruleId.length === 0) {
      return reply.code(400).send({ error: 'rule_id_required' });
    }
    if (typeof body.reason !== 'string' || body.reason.trim().length === 0) {
      return reply.code(400).send({ error: 'reason_required' });
    }
    if (body.entityId !== undefined && typeof body.entityId !== 'string') {
      return reply.code(400).send({ error: 'invalid_entity_id' });
    }
    const expiresInDays = parseExpiresInDays(body.expiresInDays);
    if (expiresInDays === null) {
      return reply.code(400).send({ error: 'invalid_expires_in_days', max: MAX_EXPIRES_IN_DAYS });
    }

    const repo = new SuppressionsRepository(pool);
    try {
      const suppression = await repo.create({
        ruleId: body.ruleId,
        entityId: (body.entityId as string | undefined) ?? null,
        reason: body.reason,
        createdBy: session.userId,
        expiresAt: expiresAtFromDays(expiresInDays),
      });

      await new AuditLogWriter(pool).insert({
        actorType: 'human',
        actorId: session.userId,
        action: 'suppression.create',
        subjectType: 'suppression',
        subjectId: suppression.id,
        payload: { ruleId: suppression.ruleId, entityId: suppression.entityId, reason: suppression.reason },
      });

      return reply.code(201).send({ suppression });
    } catch (err) {
      if (err instanceof SuppressionEmptyReasonError) {
        return reply.code(400).send({ error: 'reason_required' });
      }
      throw err;
    }
  });

  // AC5: "the dashboard shows active suppressions" — exposed via the API;
  // apps/dashboard has no real UI framework yet (P6-01/P6-08's own scope).
  fastify.get('/suppressions', { preHandler: requireRole('read_only') }, async (_request, reply) => {
    const repo = new SuppressionsRepository(pool);
    const suppressions = await repo.listActive();
    return reply.code(200).send({ suppressions });
  });

  fastify.post('/suppressions/:id/revoke', { preHandler: requireRole('analyst') }, async (request, reply) => {
    const session = request.session!;
    const { id } = request.params as { id: string };

    const repo = new SuppressionsRepository(pool);
    const revoked = await repo.revoke(id, session.userId);
    if (!revoked) {
      return reply.code(404).send({ error: 'not_found' });
    }

    await new AuditLogWriter(pool).insert({
      actorType: 'human',
      actorId: session.userId,
      action: 'suppression.revoke',
      subjectType: 'suppression',
      subjectId: id,
    });

    return reply.code(200).send({ suppression: revoked });
  });

  fastify.post('/suppressions/:id/renew', { preHandler: requireRole('analyst') }, async (request, reply) => {
    const session = request.session!;
    const { id } = request.params as { id: string };
    const body = request.body as { reason?: unknown; expiresInDays?: unknown };

    if (typeof body.reason !== 'string' || body.reason.trim().length === 0) {
      return reply.code(400).send({ error: 'reason_required' });
    }
    const expiresInDays = parseExpiresInDays(body.expiresInDays);
    if (expiresInDays === null) {
      return reply.code(400).send({ error: 'invalid_expires_in_days', max: MAX_EXPIRES_IN_DAYS });
    }

    const repo = new SuppressionsRepository(pool);
    let renewed;
    try {
      renewed = await repo.renew(id, { reason: body.reason, expiresAt: expiresAtFromDays(expiresInDays) });
    } catch (err) {
      if (err instanceof SuppressionEmptyReasonError) {
        return reply.code(400).send({ error: 'reason_required' });
      }
      throw err;
    }
    if (!renewed) {
      return reply.code(404).send({ error: 'not_found' });
    }

    await new AuditLogWriter(pool).insert({
      actorType: 'human',
      actorId: session.userId,
      action: 'suppression.renew',
      subjectType: 'suppression',
      subjectId: id,
      payload: { reason: renewed.reason, expiresAt: renewed.expiresAt },
    });

    return reply.code(200).send({ suppression: renewed });
  });
}

export const suppressionsRoutes = fp(suppressionsRoutesImpl, { name: 'sentinel-suppressions-routes' });
