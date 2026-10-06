/**
 * Role-based access control (P0-09 AC2).
 *
 * "The UI only hides, never protects" means every one of these checks must
 * be enforceable with no browser involved at all — `requireRole` is a
 * Fastify `preHandler`, which runs on every request a route receives
 * regardless of whether it came from this product's own dashboard, a
 * hand-crafted curl command, or a replayed request with the UI's buttons
 * edited out of the DOM. A disabled button that the server does not also
 * check is not a security control.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from './session.js';

/** Ascending privilege. owner can do everything admin can; admin everything
 * analyst can; analyst everything read_only can. There is no role outside
 * this line — an MSP user's cross-tenant reach is a SEPARATE axis (which
 * tenant, not which permissions) and is checked by msp-access.ts, not here. */
const RANK: Record<Role, number> = {
  read_only: 0,
  analyst: 1,
  admin: 2,
  owner: 3,
};

export function roleAtLeast(role: Role, minimum: Role): boolean {
  return RANK[role] >= RANK[minimum];
}

/**
 * A Fastify preHandler factory: `{ preHandler: requireRole('admin') }`.
 *
 * Runs after the tenant-context plugin's `onRequest` hook, so `request.session`
 * is guaranteed present by the time this executes — a request with no
 * session was already rejected with 401 before any preHandler runs. This is
 * therefore purely about "the session is real, but this role isn't enough",
 * which is 403, not 401 — the two failure modes mean different things to a
 * client and should not be collapsed into one status code.
 */
export function requireRole(minimum: Role) {
  return async function requireRoleHook(request: FastifyRequest, reply: FastifyReply) {
    const role = request.session?.role;
    if (!role || !roleAtLeast(role, minimum)) {
      await reply.code(403).send({
        error: 'insufficient_role',
        message: `This action requires at least the '${minimum}' role.`,
      });
    }
  };
}
