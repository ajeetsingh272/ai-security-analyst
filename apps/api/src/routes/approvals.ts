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
 * P5-04: a destructive playbook (step-up.ts's own
 * DESTRUCTIVE_PLAYBOOKS) additionally requires a correct
 * `stepUpPassword` in the POST body — a valid token alone is refused
 * (401) for these, and the refusal is itself audited, same as every
 * other rejection kind.
 *
 * P5-05: once approved, the playbook executes immediately, in the same
 * request — matching the brief's own "tap Approve, fixed within
 * minutes" latency target, and avoiding a second piece of queue/worker
 * infrastructure this ticket does not otherwise need. A premise
 * mismatch or execution failure marks the action `failed` (with
 * `error`/manual steps recorded) and returns the CASE to
 * `awaiting_approval` (CasesRepository.returnToAwaitingApproval) so a
 * human sees it needs attention again, rather than it sitting wherever
 * its last successful state happened to be.
 *
 * Rendering an actual human-friendly confirmation PAGE (as opposed to
 * this JSON response) is dashboard/frontend scope — every other route
 * in this app is JSON-only too (m365-connector.ts, dismissals.ts, ...),
 * and a future frontend page is exactly what would call this endpoint.
 */
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { ActionsRepository, withTenantContext } from '@sentinel/db';
import { verifyApprovalTokenShape, type NonceStore } from '@sentinel/approval-tokens';
import { requiresStepUp } from '../approvals/step-up.js';
import { decideApproval, APPROVAL_ERROR_MESSAGES } from '../approvals/decide-approval.js';

export interface ApprovalsConfig {
  tokenSecret: string;
  /** P5-11/docs/runbooks/approval-token-secret-rotation.md: a token
   * signed under the secret BEFORE the most recent rotation, still
   * accepted for verification (never for signing new tokens) during
   * the overlap window — see @sentinel/approval-tokens' own doc
   * comment on verifyApprovalTokenShape for why this exists at all. */
  previousTokenSecret?: string;
}

export interface ApprovalsRoutesOptions {
  pool: Pool;
  nonceStore: NonceStore;
  config?: ApprovalsConfig | undefined;
}

/** Every secret a token is allowed to verify against right now — the
 * current one always, the previous one too during a rotation's own
 * overlap window. Exported so slack-webhook.ts's own `decideApproval`
 * call (the Slack "approve" button reaches the identical verification
 * path, P5-07) accepts the same rotation window, not a narrower one. */
export function acceptedTokenSecrets(config: ApprovalsConfig): readonly string[] {
  return config.previousTokenSecret ? [config.tokenSecret, config.previousTokenSecret] : [config.tokenSecret];
}

export async function approvalsRoutes(fastify: FastifyInstance, options: ApprovalsRoutesOptions): Promise<void> {
  const { pool, nonceStore, config } = options;

  fastify.get<{ Params: { token: string } }>('/approvals/:token', async (request, reply) => {
    if (!config) return reply.code(503).send({ error: 'approvals_not_configured' });

    const result = verifyApprovalTokenShape(request.params.token, acceptedTokenSecrets(config));
    if (!result.ok) {
      return reply.code(400).send({ error: result.error, message: APPROVAL_ERROR_MESSAGES[result.error] });
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

    const outcome = await decideApproval(pool, nonceStore, acceptedTokenSecrets(config), request.params.token, request.body?.stepUpPassword);

    if (outcome.kind === 'rejected') return reply.code(400).send({ error: outcome.error, message: APPROVAL_ERROR_MESSAGES[outcome.error] });
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
  const previousTokenSecret = process.env['APPROVAL_TOKEN_SECRET_PREVIOUS'];
  return previousTokenSecret ? { tokenSecret, previousTokenSecret } : { tokenSecret };
}
