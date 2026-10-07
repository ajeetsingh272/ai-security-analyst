/**
 * P5-03/ADR-0007: the HTTP surface for a signed single-use approval
 * token. No session is required or possible here — the approver is
 * reacting to a WhatsApp/Slack/email alert at 2am, not sitting in an
 * authenticated browser session (same "no session" situation
 * routes/whatsapp-webhook.ts already has, for the same underlying
 * reason) — so this route is also public (see app.ts's publicPaths)
 * and resolves its own tenant context from the TOKEN, never from
 * `request.session`.
 *
 * GET never mutates (T5: a link-preview bot's own GET must execute
 * nothing) — it only verifies shape/signature/expiry
 * (verifyApprovalTokenShape) and returns what WOULD be approved. POST
 * is the only path that burns the nonce (verifyAndConsume) and
 * actually transitions the action. Every outcome — success or any of
 * the four failure kinds — is audited (ADR: "failure is closed...
 * explicit message, and an audit entry").
 *
 * This route only decides and records APPROVAL — it does not execute
 * the underlying playbook (P5-05's own job, consuming an action once
 * its status is 'approved'). P5-04: a destructive playbook
 * (step-up.ts's own DESTRUCTIVE_PLAYBOOKS) additionally requires a
 * correct `stepUpPassword` in the POST body — a valid token alone is
 * refused (401) for these, and the refusal is itself audited, same as
 * every other rejection kind.
 *
 * Rendering an actual human-friendly confirmation PAGE (as opposed to
 * this JSON response) is dashboard/frontend scope — every other route
 * in this app is JSON-only too (m365-connector.ts, dismissals.ts, ...),
 * and a future frontend page is exactly what would call this endpoint.
 */
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { AuditLogWriter, ActionsRepository, withTenantContext } from '@sentinel/db';
import { verifyApprovalTokenShape, verifyAndConsume, type ApprovalTokenVerifyError, type ApprovalTokenVerifyResult, type NonceStore } from '@sentinel/approval-tokens';
import { requiresStepUp, verifyStepUpPassword } from '../approvals/step-up.js';

export interface ApprovalsConfig {
  tokenSecret: string;
}

export interface ApprovalsRoutesOptions {
  pool: Pool;
  nonceStore: NonceStore;
  config?: ApprovalsConfig | undefined;
}

const ERROR_MESSAGES: Record<ApprovalTokenVerifyError, string> = {
  malformed: 'This link is not a valid approval link.',
  bad_signature: 'This link is not a valid approval link.',
  expired: 'This link has expired. Links are valid for 15 minutes — please use the dashboard instead.',
  reused: 'This link has already been used.',
};

/** malformed/bad_signature never carry a trustworthy payload (see
 * @sentinel/approval-tokens' own ApprovalTokenVerifyResult doc comment)
 * — there is no tenant to scope an audit entry to, so none is written
 * for those two kinds. expired/reused always do, since by definition
 * the signature already checked out by the time either can occur. */
async function auditRejection(pool: Pool, result: Extract<ApprovalTokenVerifyResult, { ok: false }>): Promise<void> {
  if (!('payload' in result)) return;
  const { payload } = result;
  await withTenantContext(payload.tenantId, () =>
    new AuditLogWriter(pool).insert({
      actorType: 'human',
      actorId: payload.approverId,
      action: 'approval_rejected',
      subjectType: 'action',
      subjectId: payload.actionId,
      payload: { reason: result.error },
    }),
  );
}

export async function approvalsRoutes(fastify: FastifyInstance, options: ApprovalsRoutesOptions): Promise<void> {
  const { pool, nonceStore, config } = options;

  fastify.get<{ Params: { token: string } }>('/approvals/:token', async (request, reply) => {
    if (!config) return reply.code(503).send({ error: 'approvals_not_configured' });

    const result = verifyApprovalTokenShape(request.params.token, config.tokenSecret);
    if (!result.ok) {
      return reply.code(400).send({ error: result.error, message: ERROR_MESSAGES[result.error] });
    }

    const action = await withTenantContext(result.payload.tenantId, () => new ActionsRepository(pool).findById(result.payload.actionId));
    if (!action || action.caseId !== result.payload.caseId) {
      return reply.code(404).send({ error: 'not_found', message: 'This action no longer exists.' });
    }

    return reply.code(200).send({
      caseId: action.caseId,
      actionId: action.id,
      playbook: action.playbook,
      blastRadius: action.blastRadius,
      status: action.status,
      alreadyDecided: action.status !== 'proposed',
      requiresStepUp: requiresStepUp(action.playbook),
    });
  });

  fastify.post<{ Params: { token: string }; Body: { stepUpPassword?: string } }>('/approvals/:token', async (request, reply) => {
    if (!config) return reply.code(503).send({ error: 'approvals_not_configured' });

    const result = await verifyAndConsume(request.params.token, config.tokenSecret, nonceStore);
    if (!result.ok) {
      await auditRejection(pool, result);
      return reply.code(400).send({ error: result.error, message: ERROR_MESSAGES[result.error] });
    }

    const { payload } = result;
    const outcome = await withTenantContext(payload.tenantId, async () => {
      const actions = new ActionsRepository(pool);
      const action = await actions.findById(payload.actionId);
      if (!action || action.caseId !== payload.caseId) return { kind: 'not_found' as const };

      if (requiresStepUp(action.playbook)) {
        // T2: enforced here, server-side, regardless of what called this
        // endpoint — never only a UI-level gate.
        const stepUpOk = request.body?.stepUpPassword ? await verifyStepUpPassword(pool, payload.approverId, request.body.stepUpPassword) : false;
        if (!stepUpOk) {
          // T4: the action is never touched — it stays exactly where it
          // was (`proposed`), not transitioned and then reverted.
          await new AuditLogWriter(pool).insert({
            actorType: 'human',
            actorId: payload.approverId,
            action: 'step_up_failed',
            subjectType: 'action',
            subjectId: payload.actionId,
            payload: { playbook: action.playbook },
          });
          return { kind: 'step_up_failed' as const };
        }
      }

      const approved = await actions.approve(payload.actionId, payload.caseId, payload.approverId, requiresStepUp(action.playbook) ? true : undefined);
      return { kind: 'decided' as const, approved };
    });

    if (outcome.kind === 'not_found') return reply.code(404).send({ error: 'not_found', message: 'This action no longer exists.' });
    if (outcome.kind === 'step_up_failed') {
      return reply.code(401).send({ error: 'step_up_failed', message: 'Re-authentication is required for this action. Provide stepUpPassword and try again.' });
    }
    return reply.code(200).send({ ok: true, alreadyDecided: !outcome.approved });
  });
}

export function approvalsConfigFromEnv(): ApprovalsConfig | undefined {
  const tokenSecret = process.env['APPROVAL_TOKEN_SECRET'];
  if (!tokenSecret) return undefined;
  return { tokenSecret };
}
