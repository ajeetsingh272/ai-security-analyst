/**
 * P5-02: the WhatsApp Cloud API's inbound webhook — the handshake Meta
 * requires before enabling a subscription (GET), and the actual event
 * delivery (POST): button taps and opt-outs.
 *
 * Registered WITHOUT fastify-plugin, unlike every other route file in
 * this directory — deliberately. The POST handler needs the RAW
 * request bytes to verify Meta's `X-Hub-Signature-256` HMAC before
 * trusting anything in the body; Fastify's default JSON parser
 * destroys those bytes before a handler ever sees them. Overriding the
 * content-type parser is exactly the kind of change that must NOT leak
 * to this app's other routes (which all expect an already-parsed JSON
 * object), so this file keeps Fastify's own per-plugin encapsulation
 * instead of breaking out of it with `fp()` — the opposite choice from
 * tenant-context.ts, and for the opposite reason (that file's own doc
 * comment explains why ITS state must escape encapsulation; this
 * file's must not).
 *
 * This route has no session (Meta is calling it, not a logged-in
 * user), so it is listed in app.ts's tenantContextPlugin `publicPaths`
 * and resolves its own tenant id from the button payload itself,
 * exactly the way WhatsAppChannel encoded it at send time
 * (`approve:<tenantId>:<actionId>`, `call_me_first:<tenantId>:<actionId>`,
 * `optout:<tenantId>`).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { AuditLogWriter, ActionsRepository, NotificationOptoutRepository, withTenantContext } from '@sentinel/db';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export interface WhatsAppConfig {
  verifyToken: string;
  appSecret: string;
}

export interface WhatsAppWebhookRoutesOptions {
  pool: Pool;
  config?: WhatsAppConfig | undefined;
}

interface WhatsAppInboundMessage {
  from: string;
  type: string;
  button?: { payload: string; text: string };
}

interface WhatsAppWebhookBody {
  entry?: Array<{ changes?: Array<{ value?: { messages?: WhatsAppInboundMessage[] } }> }>;
}

function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expectedHex = header.slice('sha256='.length);
  const actual = createHmac('sha256', appSecret).update(rawBody).digest();
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHex, 'hex');
  } catch {
    return false;
  }
  // timingSafeEqual requires equal-length buffers — a length mismatch is
  // conclusively "not a match" and leaks nothing beyond that (same
  // reasoning apps/api/src/auth/password.ts's own verify already uses).
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

async function recordButtonTap(pool: Pool, message: WhatsAppInboundMessage, log: FastifyRequest['log']): Promise<void> {
  const payload = message.button?.payload;
  if (!payload) return;
  const [intent, tenantId, actionId] = payload.split(':');

  if (intent === 'optout' && tenantId) {
    await withTenantContext(tenantId, async () => {
      await new NotificationOptoutRepository(pool).optOut('whatsapp', message.from);
      await new AuditLogWriter(pool).insert({
        actorType: 'human',
        actorId: message.from,
        action: 'whatsapp_recipient_opted_out',
        subjectType: 'notification_recipient',
        subjectId: message.from,
      });
    });
    return;
  }

  if ((intent === 'approve' || intent === 'call_me_first') && tenantId && actionId) {
    await withTenantContext(tenantId, async () => {
      const action = await new ActionsRepository(pool).findById(actionId);
      if (!action) {
        log.warn({ tenant_id: tenantId, action_id: actionId }, 'WhatsApp button tap referenced an action that does not exist for this tenant');
        return;
      }
      // P5-03/P5-04 own actually AUTHORIZING and EXECUTING this intent
      // (signed single-use tokens, step-up auth) — this route only
      // resolves the tap to the real case/action it refers to and
      // records that a human expressed this intent, auditably. Nothing
      // here executes a playbook.
      await new AuditLogWriter(pool).insert({
        actorType: 'human',
        actorId: message.from,
        action: 'whatsapp_button_tapped',
        subjectType: 'action',
        subjectId: actionId,
        payload: { intent, case_id: action.caseId },
      });
    });
  }
}

export async function whatsappWebhookRoutes(fastify: FastifyInstance, options: WhatsAppWebhookRoutesOptions): Promise<void> {
  const { pool, config } = options;

  // Scoped to this plugin instance ONLY (see file's own doc comment) —
  // captures the exact bytes Meta signed, then parses them the same
  // way Fastify's own default JSON parser would.
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    request.rawBody = body as Buffer;
    if (body.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  fastify.get<{ Querystring: Record<string, string> }>('/webhooks/whatsapp', async (request, reply) => {
    if (!config) return reply.code(503).send({ error: 'whatsapp_not_configured' });
    const mode = request.query['hub.mode'];
    const token = request.query['hub.verify_token'];
    const challenge = request.query['hub.challenge'];
    if (mode === 'subscribe' && token === config.verifyToken && challenge) {
      return reply.code(200).header('content-type', 'text/plain').send(challenge);
    }
    return reply.code(403).send({ error: 'verification_failed' });
  });

  fastify.post('/webhooks/whatsapp', async (request, reply) => {
    if (!config) return reply.code(503).send({ error: 'whatsapp_not_configured' });

    const signatureHeader = request.headers['x-hub-signature-256'];
    const header = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    if (!verifySignature(request.rawBody ?? Buffer.alloc(0), header, config.appSecret)) {
      return reply.code(401).send({ error: 'invalid_signature' });
    }

    const body = request.body as WhatsAppWebhookBody;
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const message of change.value?.messages ?? []) {
          if (message.type === 'button') {
            await recordButtonTap(pool, message, request.log).catch((err) => {
              request.log.error({ err }, 'failed to record a WhatsApp button tap');
            });
          }
        }
      }
    }

    return reply.code(200).send({ ok: true });
  });
}

export function whatsappConfigFromEnv(): WhatsAppConfig | undefined {
  const verifyToken = process.env['WHATSAPP_VERIFY_TOKEN'];
  const appSecret = process.env['WHATSAPP_APP_SECRET'];
  if (!verifyToken || !appSecret) return undefined;
  return { verifyToken, appSecret };
}
