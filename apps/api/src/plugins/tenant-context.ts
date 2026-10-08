/**
 * The HTTP half of the tenant context boundary (P0-05 AC3, ADR-0008).
 *
 * The database half (`SET LOCAL app.tenant_id`, construction-time guard) is
 * @sentinel/db's TenantScopedRepository. This plugin is what connects an
 * incoming request to that mechanism: it reads `request.session.tenantId`
 * and establishes it as the active tenant context for every hook and handler
 * that runs after this one, for the remainder of the request.
 *
 * `request.session` is a CONTRACT, not something this plugin populates.
 * P0-09's `authPlugin` is what sets it. This plugin does not know or care
 * how a session was established; it only enforces that one exists before
 * any route handler runs; a request with no session gets 401 here and
 * never reaches a handler, a repository, or a database connection at all.
 *
 * MUST be registered AFTER `authPlugin`, not before — both are registered
 * top-level (`fastify-plugin`), so Fastify runs their `onRequest` hooks in
 * REGISTRATION order. Register this one first and its check runs before
 * authPlugin has populated anything, so every request looks unauthenticated
 * even with a valid session cookie attached. Caught by this exact mistake in
 * apps/api/src/__tests__/auth.integration.test.ts the first time the two
 * were wired together.
 *
 * Two things had to be true before context set in `onRequest` reliably
 * reached the route handler, and diagnosing them cost more effort than
 * everything else in this file combined:
 *
 *   1. Use `enterTenantContext`, not `withTenantContext`. The latter wraps a
 *      callback in `AsyncLocalStorage.run()`, and `onRequest(request, reply,
 *      done)`'s `done` typically resolves a promise Fastify already created
 *      before calling the hook — so calling `done()` from inside `run()`'s
 *      callback does not make that PRE-EXISTING promise's continuation
 *      inherit the context. `enterTenantContext` mutates the ambient context
 *      for the rest of the current execution directly, sidestepping that.
 *
 *   2. Wrap the plugin with `fastify-plugin` (`fp`). This was the one that
 *      actually mattered: `fastify.register(plugin)` creates an encapsulated
 *      child context, and a hook added inside one — even an `async` hook
 *      with `enterWith` called synchronously inline, no callback involved —
 *      still lost the context by the time the route handler ran. The exact
 *      same hook added directly on the root instance (no `register()`)
 *      worked correctly; isolating that difference is what pointed at
 *      encapsulation rather than anything about AsyncLocalStorage itself.
 *      `fastify-plugin` is the Fastify ecosystem's standard way to opt a
 *      plugin out of encapsulation — the same mechanism official plugins
 *      like `@fastify/cors` use — not a workaround invented for this file.
 *
 * Confirmed empirically, not from documentation: three isolated reproductions
 * (plain AsyncLocalStorage across setImmediate/nextTick/a pre-created
 * promise; a bare `addHook` on the root instance; the same hook through
 * `register()`) narrowed the cause to encapsulation specifically before this
 * was written. If a future Fastify version changes this behaviour, that
 * narrowing is the place to re-run, not just this comment.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { enterTenantContext, exitTenantContext } from '@sentinel/db';
// Importing this for its side-effecting `declare module 'fastify'` block —
// session.ts is the one place that type is declared (P0-09). Populated by
// the auth plugin before this plugin's hook runs.
import '../auth/session.js';

export interface TenantContextPluginOptions {
  /**
   * Paths that run without a tenant context — health checks, the OAuth
   * callback that CREATES a session in the first place. An allowlist by
   * exact path rather than a pattern, so a new unauthenticated route is a
   * deliberate addition here, not something a prefix match accidentally
   * widens to cover.
   */
  publicPaths?: string[];
}

const DEFAULT_PUBLIC_PATHS = ['/health', '/ready'];

function tenantContextPluginImpl(
  fastify: FastifyInstance,
  options: TenantContextPluginOptions = {},
  done: (err?: Error) => void,
): void {
  const publicPaths = new Set(options.publicPaths ?? DEFAULT_PUBLIC_PATHS);

  fastify.addHook('onRequest', async (request: FastifyRequest, reply) => {
    // `request.routeOptions.url` is the REGISTERED route pattern
    // (e.g. `/approvals/:token`), not the literal incoming path (e.g.
    // `/approvals/eyJhbGci...`) — onRequest fires after routing in
    // Fastify's own request lifecycle, so this is already available
    // here. Matching the pattern rather than `request.url` fixes two
    // problems at once: a route with a path PARAMETER (P5-03's
    // `/approvals/:token`, one token per request) could never appear in
    // an exact-string allowlist at all if matched by literal path, and
    // `request.url` also carries the query string (P5-02's WhatsApp
    // verification handshake arrives as
    // `/webhooks/whatsapp?hub.mode=subscribe&...`), which an exact match
    // would also have rejected. Every existing publicPaths entry
    // (`/health`, `/ready`, `/auth/sign-in`, `/auth/sign-out`) has no
    // path parameters, so its own route pattern equals its own literal
    // path — this changes nothing for them. Falls back to `request.url`
    // only for the one case `routeOptions.url` is undefined (a 404,
    // where routing matched nothing at all).
    const matchedPath = request.routeOptions.url ?? request.url;
    if (publicPaths.has(matchedPath)) return;

    const tenantId = request.session?.tenantId;
    if (!tenantId) {
      // Fails closed. No session, no tenant context, no route handler runs —
      // never "proceed and let RLS return zero rows," which would turn a
      // missing-auth bug into a confusing empty-result bug three layers away.
      await reply.code(401).send({ error: 'unauthenticated', message: 'No active session.' });
      return;
    }

    try {
      enterTenantContext(tenantId);
    } catch (err) {
      // Throws synchronously on a malformed tenantId (not a UUID) — a
      // session bug, not a client bug, so 500 rather than 401.
      await reply.code(500).send({ error: 'invalid_tenant_context' });
      void err;
    }
  });

  // `enterTenantContext` mutates the ambient AsyncLocalStorage context going
  // forward rather than scoping itself to this request (see that function's
  // own comment) — on a real server with HTTP keep-alive, several requests
  // can share one continuation chain, so nothing guarantees this context is
  // gone by the time the NEXT request on that chain starts unless something
  // explicitly clears it. `onResponse` runs after every response — the 200
  // path, the 401/500 short-circuits above, and (per Fastify's lifecycle)
  // errors too — so every request cleans up after itself unconditionally,
  // regardless of whether it ever established a context in the first place.
  fastify.addHook('onResponse', async () => {
    exitTenantContext();
  });

  done();
}

export const tenantContextPlugin = fp(tenantContextPluginImpl, {
  name: 'sentinel-tenant-context',
});
