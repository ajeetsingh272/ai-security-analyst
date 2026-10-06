/**
 * P0-09 T1: each role is denied every endpoint outside its permission set.
 * Tested here as "every role below the required minimum is rejected, every
 * role at or above it is allowed" — the actual property requireRole
 * guarantees, checked exhaustively across all 16 (role × minimum) pairs
 * rather than a handful of examples.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { roleAtLeast, requireRole } from '../auth/rbac.js';
import type { Role } from '../auth/session.js';

const ROLES: Role[] = ['read_only', 'analyst', 'admin', 'owner'];
const RANK: Record<Role, number> = { read_only: 0, analyst: 1, admin: 2, owner: 3 };

describe('roleAtLeast', () => {
  for (const role of ROLES) {
    for (const minimum of ROLES) {
      it(`${role} at least ${minimum}: ${RANK[role] >= RANK[minimum]}`, () => {
        expect(roleAtLeast(role, minimum)).toBe(RANK[role] >= RANK[minimum]);
      });
    }
  }
});

function appWithGuard(minimum: Role) {
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    const role = request.headers['x-test-role'];
    if (typeof role === 'string') request.session = { tenantId: 't', userId: 'u', role: role as Role };
  });
  app.get('/protected', { preHandler: requireRole(minimum) }, async () => ({ ok: true }));
  return app;
}

describe('requireRole', () => {
  for (const minimum of ROLES) {
    for (const role of ROLES) {
      const shouldAllow = RANK[role] >= RANK[minimum];
      it(`role=${role} against a minimum of ${minimum}: ${shouldAllow ? 'allowed' : '403'}`, async () => {
        const app = appWithGuard(minimum);
        const res = await app.inject({
          method: 'GET',
          url: '/protected',
          headers: { 'x-test-role': role },
        });
        if (shouldAllow) {
          expect(res.statusCode).toBe(200);
        } else {
          expect(res.statusCode).toBe(403);
          expect(res.json()).toMatchObject({ error: 'insufficient_role' });
        }
      });
    }
  }

  it('a request with no session at all is also rejected with 403 by this guard', async () => {
    // Belt and braces: in production the tenant-context plugin's 401 would
    // already have stopped a sessionless request before this hook ever
    // runs. This asserts requireRole does not, on its own, treat "no
    // session" as "allow" if it somehow ran without that upstream check.
    const app = appWithGuard('read_only');
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(403);
  });
});
