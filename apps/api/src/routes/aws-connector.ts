/**
 * The AWS CloudTrail connector's HTTP surface (P7-02) — deliberately NOT
 * shaped like m365-connector.ts/google-connector.ts/slack-connector.ts.
 * Those three all exist because a third party (Microsoft/Google/Slack)
 * needs to show ITS OWN consent screen and hand back an authorization
 * code via browser redirect. AWS's cross-account role model has no such
 * step at all: the customer creates an IAM role in THEIR OWN AWS
 * console (following docs/connectors/aws-cloudtrail-setup.md, outside
 * this app entirely), then pastes the resulting role ARN into a plain
 * form here — a single authenticated POST, no OAuth state/PKCE/callback
 * machinery needed, because there is no browser-redirect-mediated
 * handoff to defend against.
 *
 * Two routes, not three: GET /connectors/aws/external-id (read the
 * tenant's own deterministic external id, needed BEFORE they can even
 * write their IAM role's trust policy) and POST /connectors/aws/connect
 * (store the role ARN/region/queue URL once they have). revoke is
 * identical in shape to the other three connectors' own revoke.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import { AuditLogWriter, LocalKMS, TenantCredentialVault } from '@sentinel/db';
import { requireRole } from '../auth/rbac.js';

export interface AwsConnectorRoutesOptions {
  pool: Pool;
  /** Undefined until AWS_EXTERNAL_ID_SECRET is set — every route below
   * returns 503 rather than crashing when this is unset, same pattern
   * every other optional integration in this file uses. */
  externalIdSecret?: string | undefined;
}

/**
 * The external id this tenant's own IAM role trust policy must require
 * (AC1 — AWS's own documented confused-deputy mitigation for cross-
 * account role assumption: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-user_externalid.html).
 * Deterministic (HMAC-SHA256 of the tenant id, same construction
 * packages/approval-tokens/src/token.ts's own sign() uses) rather than a
 * randomly generated, separately stored value — this needs no new
 * database column or write path at all, and is stable across repeated
 * reads of the same tenant, which the admin needs: they read it once to
 * write their trust policy, then paste the ROLE ARN here days later: the
 * external id this route computes at THAT point must be the identical
 * value they already used, with nothing to keep in sync.
 */
export function externalIdForTenant(secret: string, tenantId: string): string {
  return createHmac('sha256', secret).update(tenantId).digest('hex');
}

async function awsConnectorRoutesImpl(fastify: FastifyInstance, options: AwsConnectorRoutesOptions): Promise<void> {
  const { pool, externalIdSecret } = options;

  function requireSecret(reply: { code: (n: number) => { send: (b: unknown) => unknown } }): string | undefined {
    if (!externalIdSecret) {
      reply.code(503).send({
        error: 'aws_not_configured',
        message: 'AWS_EXTERNAL_ID_SECRET is not set.',
      });
      return undefined;
    }
    return externalIdSecret;
  }

  function requireKms(reply: { code: (n: number) => { send: (b: unknown) => unknown } }): LocalKMS | undefined {
    try {
      return new LocalKMS();
    } catch (err) {
      fastify.log.error({ err }, 'LocalKMS unavailable');
      reply.code(503).send({ error: 'kms_not_configured', message: 'KMS_LOCAL_MASTER_KEY is not set.' });
      return undefined;
    }
  }

  fastify.get('/connectors/aws/external-id', { preHandler: requireRole('admin') }, async (request, reply) => {
    const secret = requireSecret(reply);
    if (!secret) return;
    const session = request.session!;
    return reply.code(200).send({ externalId: externalIdForTenant(secret, session.tenantId) });
  });

  fastify.post<{ Body: { roleArn?: string; region?: string; queueUrl?: string } }>(
    '/connectors/aws/connect',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const secret = requireSecret(reply);
      if (!secret) return;

      const { roleArn, region, queueUrl } = request.body ?? {};
      // Shape-only validation here — the one thing this route cannot
      // prove is whether the role actually trusts this external id, or
      // whether the queue actually exists: that requires a real
      // sts:AssumeRole + sqs:ReceiveMessage call, which
      // go/sentinelconnector/aws already makes for real on its own next
      // scheduled cycle (the SAME async-discovery path every connector's
      // health already uses — see ConnectorsWizard's own "Needs
      // attention" state). Deliberately not duplicated here with a
      // second AWS SDK client just for a one-time synchronous check.
      if (!roleArn || !roleArn.startsWith('arn:aws:iam::') || !roleArn.includes(':role/')) {
        return reply.code(400).send({ error: 'invalid_role_arn', message: 'roleArn must look like arn:aws:iam::<account-id>:role/<role-name>.' });
      }
      if (!region) {
        return reply.code(400).send({ error: 'invalid_region', message: 'region is required.' });
      }
      let parsedQueueUrl: URL;
      try {
        parsedQueueUrl = new URL(queueUrl ?? '');
      } catch {
        return reply.code(400).send({ error: 'invalid_queue_url', message: 'queueUrl must be a valid URL.' });
      }
      if (parsedQueueUrl.protocol !== 'https:') {
        return reply.code(400).send({ error: 'invalid_queue_url', message: 'queueUrl must be an https:// SQS queue URL.' });
      }

      const kms = requireKms(reply);
      if (!kms) return;

      const session = request.session!;
      const externalId = externalIdForTenant(secret, session.tenantId);

      const vault = new TenantCredentialVault(pool, kms);
      const { encrypted, dekId } = await vault.encryptCredentials({
        roleArn,
        externalId,
        region,
        queueUrl: parsedQueueUrl.toString(),
      });

      await pool.query(
        `INSERT INTO connectors (tenant_id, kind, status, credentials, dek_id)
         VALUES ($1, 'aws', 'healthy', $2, $3)
         ON CONFLICT (tenant_id, kind)
         DO UPDATE SET status = 'healthy', credentials = EXCLUDED.credentials, dek_id = EXCLUDED.dek_id, last_error = NULL`,
        [session.tenantId, encrypted, dekId],
      );

      await new AuditLogWriter(pool).insert({
        actorType: 'human',
        actorId: session.userId,
        action: 'connector.consent_granted',
        subjectType: 'connector',
        subjectId: 'aws',
        payload: { region },
      });

      return reply.code(200).send({ ok: true });
    },
  );

  fastify.post('/connectors/aws/revoke', { preHandler: requireRole('admin') }, async (request, reply) => {
    const session = request.session!;

    const result = await pool.query(
      `UPDATE connectors SET status = 'revoked', credentials = NULL, dek_id = NULL
       WHERE tenant_id = $1 AND kind = 'aws'`,
      [session.tenantId],
    );
    if (result.rowCount === 0) {
      return reply.code(404).send({ error: 'not_connected' });
    }

    await new AuditLogWriter(pool).insert({
      actorType: 'human',
      actorId: session.userId,
      action: 'connector.consent_revoked',
      subjectType: 'connector',
      subjectId: 'aws',
    });

    return reply.code(200).send({ ok: true });
  });
}

export const awsConnectorRoutes = fp(awsConnectorRoutesImpl, { name: 'sentinel-aws-connector-routes' });

/** Reads AWS_EXTERNAL_ID_SECRET from the environment — undefined (not a
 * thrown error) if unset, the expected, normal state until an operator
 * provisions one. */
export function awsExternalIdSecretFromEnv(): string | undefined {
  return process.env['AWS_EXTERNAL_ID_SECRET'];
}
