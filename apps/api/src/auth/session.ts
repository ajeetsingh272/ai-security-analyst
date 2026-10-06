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
   * msp_links grant, rather than acting on their own tenant directly. */
  actingViaMspTenantId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    session?: Session;
  }
}
