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
  { href: '/settings', label: 'Settings', minRole: 'admin' },
];
