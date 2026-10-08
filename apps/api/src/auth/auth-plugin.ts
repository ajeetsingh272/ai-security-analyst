/**
 * Email + password sign-in, sessions, and sign-out (P0-09 AC1, AC4, AC5).
 *
 * OAuth is in the ticket's description but not wired to a real provider
 * here — there is no registered OAuth app or test credentials to integrate
 * against honestly, and faking a provider response would test nothing real.
 * Email+password is the concrete, fully-working path; `/auth/sign-in`'s
 * shape (verify credentials, pick a tenant via membership, create a
 * session) is exactly what an OAuth callback would do differently only in
 * how it establishes "this is who the user is" — everything after that
 * point (session creation, the cookie, the audit entry) is unchanged and
 * ready for it.
 *
 * MUST be registered BEFORE the tenant-context plugin (P0-05) — see that
 * plugin's doc comment for why. In short: this one's `onRequest` hook
 * populates `request.session` from the cookie; tenant-context's `onRequest`
 * hook reads it and rejects with 401 if absent, and Fastify runs top-level
 * hooks in registration order.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import cookie from '@fastify/cookie';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { AuditLogWriter, withTenantContext } from '@sentinel/db';
import { verifyPassword, DUMMY_PASSWORD_HASH } from './password.js';
import { SessionStore } from './session-store.js';
import { isRateLimited, recordFailedSignIn, clearFailedSignIns } from './rate-limiter.js';
import type { Role } from './session.js';
import { canActAsTenant } from './msp-access.js';

export interface AuthPluginOptions {
  pool: Pool;
  redis: RedisClientType;
  /** `secure` on the session cookie — must be true in any real deployment
   * (httpOnly+Secure+SameSite=Lax is AC1's literal requirement). Exposed as
   * an option only so integration tests can run over plain HTTP; production
   * wiring should never pass `false`. */
  cookieSecure?: boolean;
}

interface MembershipRow {
  tenant_id: string;
  role: Role;
}

const SESSION_COOKIE = 'sentinel_session';

async function auditAuthEvent(
  pool: Pool,
  tenantId: string,
  actorId: string,
  action: string,
  payload: Record<string, unknown>,
) {
  // AC5: every authentication event, success or failure, is written to the
  // audit log — failures included, because "who tried and failed to sign in
  // as whom, from where" is exactly the signal an investigation needs.
  await withTenantContext(tenantId, () =>
    new AuditLogWriter(pool).insert({
      actorType: 'human',
      actorId,
      action,
      subjectType: 'session',
      subjectId: actorId,
      payload,
    }),
  );
}

async function authPluginImpl(
  fastify: FastifyInstance,
  options: AuthPluginOptions,
): Promise<void> {
  const { pool, redis, cookieSecure = true } = options;
  const sessions = new SessionStore(redis);

  // Registered here, not left to the consumer to remember separately — this
  // plugin reads request.cookies and calls reply.setCookie/clearCookie, so
  // it is not functional without @fastify/cookie, and "functional once you
  // also do this other thing" is exactly the kind of setup step that gets
  // forgotten in a new app that wires this in.
  await fastify.register(cookie);

  fastify.post<{
    Body: { email: string; password: string; tenantId?: string };
  }>('/auth/sign-in', async (request, reply) => {
    const { email, password, tenantId: requestedTenantId } = request.body;
    const ip = request.ip;

    if (!email || !password) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    // Checked before touching the password at all — scrypt is deliberately
    // slow, and an already-blocked account/IP getting that cost spent on its
    // behalf anyway is a free amplification an attacker gets for nothing.
    const limited = await isRateLimited(redis, email, ip);
    if (limited.blocked) {
      return reply.code(429).send({
        error: 'rate_limited',
        retryAfterSeconds: limited.retryAfterSeconds,
      });
    }

    const userResult = await pool.query<{ id: string; password_hash: string | null }>(
      'SELECT id, password_hash FROM users WHERE email = $1',
      [email],
    );
    const user = userResult.rows[0];

    // Verify against a REAL stored value when the user doesn't exist, not a
    // short-circuit return — otherwise "unknown email" answers faster than
    // "wrong password", and that timing difference is an account-enumeration
    // oracle. A fixed dummy hash makes both paths do the same scrypt work.
    const hashToCheck = user?.password_hash ?? DUMMY_PASSWORD_HASH;
    const passwordOk = await verifyPassword(password, hashToCheck);

    if (!user || !passwordOk) {
      const result = await recordFailedSignIn(redis, email, ip);
      if (user) {
        // Audited under the real tenant only when we know one — an unknown
        // email has no tenant to attribute the attempt to; the IP and email
        // are still in the rate-limiter's own keys for that case.
        const anyMembership = await pool.query<MembershipRow>(
          'SELECT tenant_id, role FROM memberships WHERE user_id = $1 LIMIT 1',
          [user.id],
        );
        if (anyMembership.rows[0]) {
          await auditAuthEvent(pool, anyMembership.rows[0].tenant_id, user.id, 'auth.sign_in_failed', {
            ip,
            reason: 'bad_password',
          });
        }
      }
      return reply.code(401).send({
        error: 'invalid_credentials',
        ...(result.blocked ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
      });
    }

    const memberships = await pool.query<MembershipRow>(
      'SELECT tenant_id, role FROM memberships WHERE user_id = $1',
      [user.id],
    );

    const membership = requestedTenantId
      ? memberships.rows.find((m) => m.tenant_id === requestedTenantId)
      : memberships.rows.length === 1
        ? memberships.rows[0]
        : undefined;

    if (!membership) {
      // Deliberately after password verification, not before: revealing
      // "that password was fine, but you have no access to that tenant" to
      // someone who does not actually hold the password would leak that the
      // email/password pair IS valid for some other tenant. Rate-limiting
      // state is already updated above regardless of which branch this is.
      return reply.code(400).send({
        error: memberships.rows.length > 1 ? 'tenant_required' : 'no_membership',
        message:
          memberships.rows.length > 1
            ? 'This account belongs to multiple tenants; specify tenantId.'
            : 'This account has no tenant membership.',
      });
    }

    await clearFailedSignIns(redis, email);

    const sessionId = await sessions.create({
      tenantId: membership.tenant_id,
      homeTenantId: membership.tenant_id,
      userId: user.id,
      role: membership.role,
    });

    await auditAuthEvent(pool, membership.tenant_id, user.id, 'auth.sign_in', { ip });

    reply.setCookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: 'lax',
      path: '/',
    });
    return reply.code(200).send({ ok: true });
  });

  fastify.post('/auth/sign-out', async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE];
    if (sessionId) {
      const session = await sessions.get(sessionId);
      await sessions.revoke(sessionId);
      if (session) {
        await auditAuthEvent(pool, session.tenantId, session.userId, 'auth.sign_out', {});
      }
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(200).send({ ok: true });
  });

  // P6-01: the dashboard shell's one source of truth for "who is signed in,
  // as which tenant, with which role" — needed to render role-filtered nav
  // server-side and to refuse an unauthorised route before any client code
  // runs. Not public (tenant-context's allowlist doesn't include it), so a
  // request with no session already gets 401 before this handler runs.
  fastify.get('/auth/me', async (request, reply) => {
    const session = request.session;
    if (!session) {
      // Unreachable in production (tenant-context rejects first), but the
      // type is `Session | undefined` and this keeps the handler honest
      // about it rather than asserting with `!`.
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    const result = await pool.query<{ email: string | null; display_name: string | null }>(
      'SELECT email, display_name FROM users WHERE id = $1',
      [session.userId],
    );
    const tenantResult = await pool.query<{ name: string }>(
      'SELECT name FROM tenants WHERE id = $1',
      [session.tenantId],
    );
    const isActingAsClient = session.homeTenantId != null && session.homeTenantId !== session.tenantId;
    const homeTenantResult = isActingAsClient
      ? await pool.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [session.homeTenantId])
      : undefined;
    return reply.code(200).send({
      userId: session.userId,
      email: result.rows[0]?.email ?? null,
      displayName: result.rows[0]?.display_name ?? null,
      tenantId: session.tenantId,
      tenantName: tenantResult.rows[0]?.name ?? null,
      role: session.role,
      actingViaMspTenantId: session.actingViaMspTenantId ?? null,
      isActingAsClient,
      homeTenantId: isActingAsClient ? session.homeTenantId : null,
      homeTenantName: homeTenantResult?.rows[0]?.name ?? null,
    });
  });

  // P6-01's tenant switcher, backed by the real cross-tenant check P0-09
  // already established (canActAsTenant) but never wired to an HTTP route
  // before this — the full MSP console (P6-06) builds its client-ranking
  // view on top of this, it doesn't reinvent the switch itself.
  fastify.post<{ Body: { targetTenantId: string | null } }>('/auth/switch-tenant', async (request, reply) => {
    const session = request.session;
    if (!session) return reply.code(401).send({ error: 'unauthenticated' });

    const sessionId = request.cookies[SESSION_COOKIE];
    if (!sessionId) return reply.code(401).send({ error: 'unauthenticated' });

    const homeTenantId = session.homeTenantId ?? session.tenantId;
    const targetTenantId = request.body?.targetTenantId ?? homeTenantId;

    if (targetTenantId === homeTenantId) {
      // Switching back to the user's own tenant is always allowed — no
      // link check needed, and this is also how a client gives up acting
      // on a linked tenant.
      const homeMembership = await pool.query<MembershipRow>(
        'SELECT tenant_id, role FROM memberships WHERE user_id = $1 AND tenant_id = $2',
        [session.userId, homeTenantId],
      );
      const role = homeMembership.rows[0]?.role ?? session.role;
      await sessions.update(sessionId, { tenantId: homeTenantId, role, actingViaMspTenantId: undefined });
      await auditAuthEvent(pool, homeTenantId, session.userId, 'auth.tenant_switch', { to: homeTenantId, home: true });
      return reply.code(200).send({ ok: true, tenantId: homeTenantId });
    }

    const allowed = await withTenantContext(homeTenantId, () => canActAsTenant(pool, homeTenantId, targetTenantId));
    if (!allowed) {
      return reply.code(403).send({
        error: 'not_linked',
        message: 'Your tenant has no active link to that client tenant.',
      });
    }

    // No membership row exists in the client tenant for an MSP user acting
    // through a link — there is nothing to grant a role FROM there, so this
    // caps access to read_only rather than presuming the user's home-tenant
    // role (owner at the MSP doesn't imply owner at every linked client).
    // P6-06 may introduce a per-link granted role; until it does, read_only
    // is the honest default, not a placeholder silently treated as more.
    const clientRole: Role = 'read_only';
    await sessions.update(sessionId, { tenantId: targetTenantId, role: clientRole, actingViaMspTenantId: targetTenantId });
    await auditAuthEvent(pool, homeTenantId, session.userId, 'auth.tenant_switch', { to: targetTenantId, home: false });
    return reply.code(200).send({ ok: true, tenantId: targetTenantId, role: clientRole });
  });

  // Populates request.session from the cookie, for the tenant-context
  // plugin (P0-05) and requireRole (rbac.ts) to read. Registered on THIS
  // encapsulated plugin so it runs for every route — including /auth/* —
  // but it does not reject a missing/invalid session itself; that is the
  // tenant-context plugin's job (401, with the public-paths allowlist for
  // /auth/sign-in itself). This hook only ever ADDS information; it never
  // sends a response.
  fastify.addHook('onRequest', async (request) => {
    const sessionId = request.cookies[SESSION_COOKIE];
    if (!sessionId) return;
    const session = await sessions.get(sessionId);
    if (session) request.session = session;
  });
}

export const authPlugin = fp(authPluginImpl, { name: 'sentinel-auth' });
