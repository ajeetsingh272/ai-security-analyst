/**
 * P0-05 AC3: middleware sets app.tenant_id per transaction from the
 * authenticated session.
 *
 * `request.session` is stubbed directly in these tests via a decorator hook
 * registered before the plugin under test — standing in for whatever P0-09's
 * real auth plugin will populate it with. This suite is about the tenant
 * context plugin's own contract (401 with no session, context established
 * and isolated per request with one), not about verifying any particular
 * authentication mechanism.
 *
 * Uses `fastify.inject()` — Fastify's built-in request simulator — rather
 * than a real listening socket, so this never needs a free port or an actual
 * database connection.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { getTenantContext, hasTenantContext } from '@sentinel/db';
import { tenantContextPlugin } from '../plugins/tenant-context.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

/** A fresh app per test, with a decorator hook standing in for P0-09's auth
 * plugin, wired to whatever session the caller wants to simulate. */
function buildApp(sessionFor: (url: string) => { tenantId: string; userId: string } | undefined) {
  const app = Fastify();
  app.addHook('onRequest', (request, _reply, done) => {
    // Assigned only when truthy: under exactOptionalPropertyTypes, an
    // optional property may be omitted or hold a value, never explicitly
    // `undefined` — this is the "no session" case expressed as the key
    // being absent, matching what a real auth plugin would do by simply
    // not decorating the request at all.
    const session = sessionFor(request.url);
    if (session) request.session = session;
    done();
  });
  app.register(tenantContextPlugin);

  app.get('/health', async () => ({ ok: true, contextActive: hasTenantContext() }));
  app.get('/cases', async () => ({ tenantId: getTenantContext().tenantId }));

  return app;
}

describe('tenantContextPlugin', () => {
  it('rejects a protected route with no session, before the handler runs', async () => {
    const app = buildApp(() => undefined);
    const res = await app.inject({ method: 'GET', url: '/cases' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthenticated' });
  });

  it('allows a public path through with no session and no tenant context', async () => {
    const app = buildApp(() => undefined);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, contextActive: false });
  });

  it('establishes the tenant context from request.session for a protected route', async () => {
    const app = buildApp(() => ({ tenantId: TENANT_A, userId: 'u1' }));
    const res = await app.inject({ method: 'GET', url: '/cases' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenantId: TENANT_A });
  });

  it('does not leak context between an authenticated request and a later unauthenticated one', async () => {
    const app = buildApp((url) => (url === '/cases' ? { tenantId: TENANT_A, userId: 'u1' } : undefined));
    const first = await app.inject({ method: 'GET', url: '/cases' });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: 'GET', url: '/health' });
    expect(second.json()).toEqual({ ok: true, contextActive: false });
  });

  it('isolates concurrent requests for different tenants from each other', async () => {
    const app = buildApp((url) => {
      if (url === '/as-a') return { tenantId: TENANT_A, userId: 'u1' };
      if (url === '/as-b') return { tenantId: TENANT_B, userId: 'u2' };
      return undefined;
    });
    app.get('/as-a', async () => ({ tenantId: getTenantContext().tenantId }));
    app.get('/as-b', async () => ({ tenantId: getTenantContext().tenantId }));

    const [a, b] = await Promise.all([
      app.inject({ method: 'GET', url: '/as-a' }),
      app.inject({ method: 'GET', url: '/as-b' }),
    ]);

    expect(a.json()).toEqual({ tenantId: TENANT_A });
    expect(b.json()).toEqual({ tenantId: TENANT_B });
  });

  it('returns 500, not 401, when the session carries a malformed tenant id', async () => {
    // A non-UUID tenantId is a bug in whatever issued the session, not a
    // missing-credentials problem — the distinct status code is so an
    // operator reading logs can tell which system to look at.
    const app = buildApp(() => ({ tenantId: 'not-a-uuid', userId: 'u1' }));
    const res = await app.inject({ method: 'GET', url: '/cases' });
    expect(res.statusCode).toBe(500);
  });
});
