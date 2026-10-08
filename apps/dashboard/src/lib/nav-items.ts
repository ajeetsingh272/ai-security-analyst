import type { Role } from './session.js';

const RANK: Record<Role, number> = { read_only: 0, analyst: 1, admin: 2, owner: 3 };

export function roleAtLeast(role: Role, minimum: Role): boolean {
  return RANK[role] >= RANK[minimum];
}

export interface NavItem {
  href: string;
  label: string;
  /** Lowest role that may open this route. Enforced again, server-side, by
   * the route segment's own layout — this list only decides what a given
   * role SEES; see lib/session.ts's doc comment for where the real check
   * is. */
  minRole: Role;
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/cases', label: 'Cases', minRole: 'read_only' },
  { href: '/connectors', label: 'Connectors', minRole: 'read_only' },
  { href: '/reports', label: 'Reports', minRole: 'read_only' },
  // P6-06: visible to every tenant at admin+, not just MSP-plan ones —
  // the page itself renders an honest empty state for a tenant with no
  // linked clients, which is equally true regardless of plan type, so
  // there is no need to thread "is this tenant's plan msp" through the
  // session just to decide whether to show this link at all.
  { href: '/msp', label: 'Clients', minRole: 'admin' },
  { href: '/settings', label: 'Settings', minRole: 'admin' },
];
