/**
 * A single row in the dashboard's primary navigation. Deliberately dumb:
 * "is this the active route" is a routing concern the consuming app knows
 * (via Next's usePathname), not something this framework-agnostic package
 * should import next/navigation to find out itself — the caller passes
 * `active` in, this component only renders what that implies.
 */
import type { ReactNode } from 'react';
import { cn } from './lib/cn.js';

export interface NavLinkProps {
  href: string;
  label: string;
  icon?: ReactNode;
  active?: boolean;
  /** Rendered instead of the link entirely when the current role can't
   * reach this route — NOT a disabled/greyed-out link. A route this
   * session genuinely cannot open has no business appearing as a link at
   * all, since "the UI only hides, never protects" means the real
   * enforcement already happened server-side; hiding it here is tidiness,
   * not the security control. */
  visible?: boolean;
}

export function NavLink({ href, label, icon, active = false, visible = true }: NavLinkProps) {
  if (!visible) return null;
  return (
    <a
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 font-ui text-body-s font-medium',
        'transition-colors duration-[160ms]',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal',
        active
          ? 'bg-surface-raised text-text-primary'
          : 'text-text-secondary hover:bg-surface-raised hover:text-text-primary',
      )}
    >
      {icon && (
        <span className="shrink-0" aria-hidden="true">
          {icon}
        </span>
      )}
      <span>{label}</span>
    </a>
  );
}
