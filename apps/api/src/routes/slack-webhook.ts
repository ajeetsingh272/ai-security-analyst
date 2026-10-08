/**
 * P5-07: Slack's own interactivity webhook — a block_actions payload
 * from an Approve/Call Me First button tap. Registered WITHOUT
 * fastify-plugin, same reasoning as whatsapp-webhook.ts: this route
 * needs the RAW request body to verify Slack's own signature before
 * trusting anything in it, and that content-type-parser override must
 * stay scoped to this one route, never leaking to the rest of the app.
 *
 * Verification (https://api.slack.com/authentication/verifying-requests-from-slack):
 * `X-Slack-Request-Timestamp` rejected if more than 5 minutes old
 * (T3 — this IS the replay check; an attacker who captured a genuine
 * past interaction cannot replay it once its own timestamp has aged
 * out, regardless of whether the signature itself is still valid for
 * those exact bytes) and `X-Slack-Signature` (`v0=` + HMAC-SHA256 of
 * `v0:{timestamp}:{raw body}`, timing-safe compared) checked before
 * any JSON parsing (T2).
 *
 * Reuses decide-approval.ts's own `decideApproval` — the EXACT same
 * verify/step-up/approve/execute logic a human clicking the WhatsApp
 * or dashboard link goes through — so Slack's "same approval
 * semantics as WhatsApp" (this ticket's own words) is actually true by
 * construction, not just by intent. Step-up (P5-04) cannot be
 * satisfied inline from a button tap here any more than it can from
 * WhatsApp's — a destructive playbook's Approve tap in Slack fails
 * step-up exactly like one from WhatsApp does, correctly.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { AuditLogWriter, withTenantContext } from '@sentinel/db';
import { verifyApprovalTokenShape, type NonceStore } from '@sentinel/approval-tokens';
import { decideApproval } from '../approvals/decide-approval.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export interface SlackWebhookConfig {
  signingSecret: string;
}

export interface SlackWebhookRoutesOptions {
  pool: Pool;
  nonceStore: NonceStore;
  tokenSecret?: string | undefined;
  config?: SlackWebhookConfig | undefined;
}

const REPLAY_WINDOW_SECONDS = 5 * 60;

function verifySlackSignature(rawBody: Buffer, timestampHeader: string | undefined, signatureHeader: string | undefined, signingSecret: string): boolean {
  if (!timestampHeader || !signatureHeader?.startsWith('v0=')) return false;
  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > REPLAY_WINDOW_SECONDS) return false;

  const basestring = `v0:${timestampHeader}:${rawBody.toString('utf8')}`;
  const expected = `v0=${createHmac('sha256', signingSecret).update(basestring).digest('hex')}`;
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(signatureHeader, 'utf8');
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

interface SlackInteractionPayload {
  type: string;
  actions?: Array<{ action_id: string; value: string }>;
}

async function auditCallMeFirst(pool: Pool, tokenSecret: string, token: string): Promise<void> {
  const shape = verifyApprovalTokenShape(token, tokenSecret);
  if (!shape.ok) return; // nothing trustworthy to scope an audit entry to
  const { payload } = shape;
  await withTenantContext(payload.tenantId, () =>
    new AuditLogWriter(pool).insert({
      actorType: 'human',
      actorId: payload.approverId,
      action: 'call_me_first_requested',
      subjectType: 'action',
      subjectId: payload.actionId,
      payload: { via: 'slack' },
    }),
  );
}

export async function slackWebhookRoutes(fastify: FastifyInstance, options: SlackWebhookRoutesOptions): Promise<void> {
  const { pool, nonceStore, tokenSecret, config } = options;

  fastify.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer' }, (request, body, done) => {
    request.rawBody = body as Buffer;
    try {
      const parsed: Record<string, string> = {};
      for (const [key, value] of new URLSearchParams(body.toString('utf8'))) parsed[key] = value;
      done(null, parsed);
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  fastify.post('/webhooks/slack/interactions', async (request, reply) => {
    if (!config || !tokenSecret) return reply.code(503).send({ error: 'slack_webhook_not_configured' });

    const timestamp = request.headers['x-slack-request-timestamp'];
    const signature = request.headers['x-slack-signature'];
    const timestampHeader = Array.isArray(timestamp) ? timestamp[0] : timestamp;
    const signatureHeader = Array.isArray(signature) ? signature[0] : signature;
    if (!verifySlackSignature(request.rawBody ?? Buffer.alloc(0), timestampHeader, signatureHeader, config.signingSecret)) {
      return reply.code(401).send({ error: 'invalid_signature' });
    }

    const body = request.body as Record<string, string>;
    let interaction: SlackInteractionPayload;
    try {
      interaction = JSON.parse(body['payload'] ?? '{}') as SlackInteractionPayload;
    } catch {
      return reply.code(400).send({ error: 'invalid_payload' });
    }

    for (const action of interaction.actions ?? []) {
      if (action.action_id === 'approve') {
        await decideApproval(pool, nonceStore, tokenSecret, action.value, undefined);
      } else if (action.action_id === 'call_me_first') {
        await auditCallMeFirst(pool, tokenSecret, action.value);
      }
    }

    return reply.code(200).send({ ok: true });
  });
}

export function slackWebhookConfigFromEnv(): SlackWebhookConfig | undefined {
  const signingSecret = process.env['SLACK_SIGNING_SECRET'];
  if (!signingSecret) return undefined;
  return { signingSecret };
}
