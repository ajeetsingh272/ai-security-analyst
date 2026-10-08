/**
 * P6-12: in-product feedback attached to a case or a weekly report.
 * `requireRole('read_only')` — surfacing your own experience with a
 * case or report is not a privileged action, same bar GET routes in
 * this API already set (dismissals.ts, suppressions.ts).
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';
import { AuditLogWriter, FeedbackRepository, type FeedbackSubjectType } from '@sentinel/db';
import { requireRole } from '../auth/rbac.js';

export interface FeedbackRoutesOptions {
  pool: Pool;
}

const VALID_SUBJECT_TYPES = new Set<FeedbackSubjectType>(['case', 'weekly_report']);

async function feedbackRoutesImpl(fastify: FastifyInstance, options: FeedbackRoutesOptions): Promise<void> {
  const { pool } = options;

  fastify.post('/feedback', { preHandler: requireRole('read_only') }, async (request, reply) => {
    const session = request.session!;
    const body = request.body as { subjectType?: unknown; subjectId?: unknown; isFalsePositive?: unknown; comment?: unknown };

    if (typeof body.subjectType !== 'string' || !VALID_SUBJECT_TYPES.has(body.subjectType as FeedbackSubjectType)) {
      return reply.code(400).send({ error: 'invalid_subject_type', allowed: Array.from(VALID_SUBJECT_TYPES) });
    }
    if (typeof body.subjectId !== 'string' || body.subjectId.length === 0) {
      return reply.code(400).send({ error: 'subject_id_required' });
    }
    if (body.comment !== undefined && typeof body.comment !== 'string') {
      return reply.code(400).send({ error: 'invalid_comment' });
    }

    const repo = new FeedbackRepository(pool);
    const { feedback, tuningBacklogItem } = await repo.create({
      subjectType: body.subjectType as FeedbackSubjectType,
      subjectId: body.subjectId,
      userId: session.userId,
      isFalsePositive: body.isFalsePositive === true,
      comment: (body.comment as string | undefined) ?? null,
    });

    await new AuditLogWriter(pool).insert({
      actorType: 'human',
      actorId: session.userId,
      action: 'feedback.submitted',
      subjectType: feedback.subjectType,
      subjectId: feedback.subjectId,
      payload: { isFalsePositive: feedback.isFalsePositive },
    });

    return reply.code(201).send({ feedback, tuningBacklogItem });
  });
}

export const feedbackRoutes = fp(feedbackRoutesImpl, { name: 'sentinel-feedback-routes' });
