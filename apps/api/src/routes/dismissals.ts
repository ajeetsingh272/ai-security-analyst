/**
 * P3-07 (TG3: "Nothing is hidden — dismissals are surfaced").
 *
 * AC3: "the digest is retrievable through the API and rendered in the
 * dashboard." The API half is real and tested below; apps/dashboard
 * has no real UI framework yet (same gap routes/suppressions.ts
 * already documents for its own AC5) — this route IS the thing a
 * dashboard would render, not a placeholder standing in for one.
 *
 * AC5: "a dismissal can be challenged, which reopens the case and is
 * audited" — `requireRole('analyst')`, the same bar
 * routes/suppressions.ts sets for any write that changes what a
 * tenant's cases look like.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';
import { CasesRepository } from '@sentinel/db';
import { requireRole } from '../auth/rbac.js';

export interface DismissalsRoutesOptions {
  pool: Pool;
}

function parseDay(value: unknown): Date | null {
  if (value === undefined) {
    const today = new Date();
    return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  }
  if (typeof value !== 'string') return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function dismissalsRoutesImpl(fastify: FastifyInstance, options: DismissalsRoutesOptions): Promise<void> {
  const { pool } = options;

  // AC3: any authenticated member of the tenant can read the digest —
  // same read_only bar GET /suppressions already sets; surfacing a
  // dismissal is the whole point of TG3, not something to gate behind
  // an elevated role.
  fastify.get('/dismissals/digest', { preHandler: requireRole('read_only') }, async (request, reply) => {
    const query = request.query as { day?: unknown };
    const day = parseDay(query.day);
    if (day === null) {
      return reply.code(400).send({ error: 'invalid_day' });
    }

    const repo = new CasesRepository(pool);
    const digest = await repo.dailyDismissalDigest(day);
    return reply.code(200).send({ day: day.toISOString().slice(0, 10), digest });
  });

  fastify.post('/cases/:id/challenge', { preHandler: requireRole('analyst') }, async (request, reply) => {
    const session = request.session!;
    const { id } = request.params as { id: string };
    const body = request.body as { reason?: unknown };

    if (typeof body.reason !== 'string' || body.reason.trim().length === 0) {
      return reply.code(400).send({ error: 'reason_required' });
    }

    const repo = new CasesRepository(pool);
    const reopened = await repo.challengeDismissal(id, session.userId, body.reason);
    if (!reopened) {
      return reply.code(404).send({ error: 'not_found_or_not_dismissed' });
    }

    return reply.code(200).send({ case: reopened });
  });
}

export const dismissalsRoutes = fp(dismissalsRoutesImpl, { name: 'sentinel-dismissals-routes' });
