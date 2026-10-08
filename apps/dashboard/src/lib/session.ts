/**
 * Server-only: asks the real API "who is this, as which tenant, with which
 * role" (GET /auth/me, apps/api/src/auth/auth-plugin.ts) and forwards the
 * incoming request's own cookie header to do it — a Server Component has
 * no browser to carry that cookie for it automatically the way a
 * same-origin client fetch would. This is also the P6-01 AC4 enforcement
 * point: every authenticated route segment's layout calls this and
 * redirects before rendering anything if it comes back null, so an
 * unauthorised request is refused before a single byte of page content is
 * produced — not merely a nav item that happens not to be shown.
 */
import { cookies } from 'next/headers';
import { API_BASE_URL } from './api-base.js';

/** Mirrors apps/api/src/auth/session.ts's `Role` — duplicated rather than
 * imported because apps/dashboard and apps/api are separately deployable
 * processes with no workspace dependency between them; the wire contract
 * (this type) is what actually couples them, same as any other HTTP API
 * client would be. */
export type Role = 'owner' | 'admin' | 'analyst' | 'read_only';

export interface CurrentUser {
  userId: string;
  email: string | null;
  displayName: string | null;
  tenantId: string;
  tenantName: string | null;
  role: Role;
  actingViaMspTenantId: string | null;
  isActingAsClient: boolean;
  homeTenantId: string | null;
  homeTenantName: string | null;
}

/** Null means "not signed in" — never throws for that case, since it is the
 * expected outcome for a visitor with no session, not an error. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  const res = await fetch(`${API_BASE_URL}/auth/me`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: 'no-store',
  });

  if (!res.ok) return null;
  return (await res.json()) as CurrentUser;
}
