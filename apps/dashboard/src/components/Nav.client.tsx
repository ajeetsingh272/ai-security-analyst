'use client';

import { usePathname } from 'next/navigation';
import { NavLink } from '@sentinel/ui';
import type { NavItem } from '../lib/nav-items.js';

export interface NavProps {
  /** Already role-filtered server-side by the layout that renders this —
   * this component only decides which one is ACTIVE, never which ones
   * exist. */
  items: NavItem[];
}

export function Nav({ items }: NavProps) {
  const pathname = usePathname();
  return (
    <>
      {items.map((item) => (
        <NavLink
          key={item.href}
          href={item.href}
          label={item.label}
          active={pathname === item.href || pathname.startsWith(`${item.href}/`)}
        />
      ))}
    </>
  );
}
