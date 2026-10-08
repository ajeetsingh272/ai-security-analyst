/**
 * P5-08 AC4/T3: Resend's own bounce/complaint webhook
 * (https://resend.com/docs/dashboard/webhooks/event-types), signed via
 * Svix (https://docs.svix.com/receiving/verifying-payloads/how-manual)
 * — `svix-id`/`svix-timestamp`/`svix-signature` over
 * `{id}.{timestamp}.{raw body}`, HMAC-SHA256 with the base64-decoded
 * secret (Svix's own `whsec_` prefix stripped first), timing-safe
 * compared. Same raw-body-before-JSON-parsing shape every other
 * signed webhook in this app already uses (whatsapp-webhook.ts,
 * slack-webhook.ts) — registered without fastify-plugin for the same
 * reason: the content-type-parser override must stay scoped to this
 * one route.
 *
 * "Surfaced on the tenant's channel health" (AC4) is the SAME fact a
 * WhatsApp opt-out button tap already records — NotificationOptoutRepository,
 * channel = 'email' — since "this address hard-bounced" and "this
 * address opted out" both mean the identical thing operationally:
 * stop sending here. EmailChannel checks that exact store before
 * every send (email-channel.ts).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { withTenantContext, NotificationOptoutRepository, AuditLogWriter } from '@sentinel/db';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export interface ResendWebhookConfig {
  signingSecret: string;
}

export interface ResendWebhookRoutesOptions {
  pool: Pool;
  config?: ResendWebhookConfig | undefined;
}

const REPLAY_WINDOW_SECONDS = 5 * 60;

function verifySvixSignature(id: string | undefined, timestamp: string | undefined, signatureHeader: string | undefined, rawBody: Buffer, signingSecret: string): boolean {
  if (!id || !timestamp || !signatureHeader) return false;
  const timestampNum = Number(timestamp);
  if (!Number.isFinite(timestampNum)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestampNum) > REPLAY_WINDOW_SECONDS) return false;

  const secretBytes = Buffer.from(signingSecret.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${id}.${timestamp}.${rawBody.toString('utf8')}`;
  const expected = createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  const expectedBuf = Buffer.from(expected, 'base64');

  // Svix sends a space-separated list of `v1,<sig>` pairs (secret
  // rotation support) — any one matching is a valid signature.
  return signatureHeader.split(' ').some((candidate) => {
    const [version, sig] = candidate.split(',');
    if (version !== 'v1' || !sig) return false;
    let candidateBuf: Buffer;
    try {
      candidateBuf = Buffer.from(sig, 'base64');
    } catch {
      return false;
    }
    return candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf);
  });
}

interface ResendBounceEvent {
  type: string;
  data?: { to?: string[]; tenant_id?: string };
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export async function resendWebhookRoutes(fastify: FastifyInstance, options: ResendWebhookRoutesOptions): Promise<void> {
  const { pool, config } = options;

  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    request.rawBody = body as Buffer;
    if (body.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  fastify.post('/webhooks/resend', async (request, reply) => {
    if (!config) return reply.code(503).send({ error: 'resend_webhook_not_configured' });

    const valid = verifySvixSignature(header(request, 'svix-id'), header(request, 'svix-timestamp'), header(request, 'svix-signature'), request.rawBody ?? Buffer.alloc(0), config.signingSecret);
    if (!valid) return reply.code(401).send({ error: 'invalid_signature' });

    const event = request.body as ResendBounceEvent;
    // P5-08's own scoping note: Resend's real webhook payload has no
    // tenant concept at all — it is a platform-wide API account, not
    // a per-tenant OAuth install (unlike Slack/M365). `data.tenant_id`
    // is this codebase's OWN convention, expected to be set via a
    // custom header/tag on the ORIGINAL send (Resend supports request
    // tagging) once a real caller sends tenant-attributed email —
    // honestly unresolved here the same way "which tenant" is for any
    // event with no real sender wiring yet (mirrors
    // apps/analyst/src/worker.ts's own repeated "no real delivery
    // channel exists yet" notes for exactly this class of gap).
    if ((event.type === 'email.bounced' || event.type === 'email.complained') && event.data?.tenant_id && event.data.to?.length) {
      const tenantId = event.data.tenant_id;
      for (const recipient of event.data.to) {
        await withTenantContext(tenantId, async () => {
          await new NotificationOptoutRepository(pool).optOut('email', recipient);
          await new AuditLogWriter(pool).insert({
            actorType: 'system',
            actorId: 'resend-webhook',
            action: event.type === 'email.bounced' ? 'email_bounced' : 'email_complained',
            subjectType: 'notification_recipient',
            subjectId: recipient,
          });
        });
      }
    }

    return reply.code(200).send({ ok: true });
  });
}

export function resendWebhookConfigFromEnv(): ResendWebhookConfig | undefined {
  const signingSecret = process.env['RESEND_WEBHOOK_SECRET'];
  if (!signingSecret) return undefined;
  return { signingSecret };
}
