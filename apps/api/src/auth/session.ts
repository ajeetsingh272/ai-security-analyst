/**
 * The shape of an authenticated session (P0-09), and the single place
 * `FastifyRequest.session` is declared. P0-05's tenant-context plugin reads
 * `request.session.tenantId`; this is where that field actually comes from
 * now that the auth layer exists to produce it.
 */

export type Role = 'owner' | 'admin' | 'analyst' | 'read_only';

export interface Session {
  /** Which tenant this request is acting as. For an MSP user with access to
   * several client tenants, this is whichever ONE the current request is
   * scoped to — never a list; see rbac.ts for how that gets picked. */
  tenantId: string;
  userId: string;
  role: Role;
  /** Present only for an MSP user acting on a client tenant through a
   * msp_links grant, rather than acting on their own tenant directly.
   * Explicitly `| undefined` (not just optional) so `switch-tenant`'s
   * "back to home" path can clear it via SessionStore.update's merge
   * under `exactOptionalPropertyTypes`. */
  actingViaMspTenantId?: string | undefined;
  /** The tenant this session originally signed into — set at sign-in,
   * never changed afterward. Absent is equivalent to "equal to tenantId"
   * (every session created before P6-01 had no notion of switching, so
   * that's the correct default rather than a migration). This is what
   * `POST /auth/switch-tenant` (P6-01) checks `canActAsTenant` against and
   * switches back to, since `tenantId` itself gets overwritten while
   * acting on a client. */
  homeTenantId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    session?: Session;
  }
}
