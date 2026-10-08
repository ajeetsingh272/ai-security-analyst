/**
 * The shell's tenant switcher (P6-01). Presentational and controlled, same
 * reasoning as ThemeToggleButton: the actual POST to /auth/switch-tenant
 * and the resulting navigation are a "use client" concern for
 * apps/dashboard, not this package.
 *
 * With a single option (the common case — most users belong to exactly one
 * tenant and are never MSP-linked to another) this renders as plain static
 * text, not a dropdown with nothing to choose. The MSP console (P6-06)
 * builds its own ranked, searchable 200-client view on top of the same
 * `options` data; this component is only ever the small header-level
 * affordance, not that view.
 */
import { cn } from './lib/cn.js';

export interface TenantOption {
  id: string;
  name: string;
}

export interface TenantSwitcherProps {
  current: TenantOption;
  options: TenantOption[];
  onSwitch: (tenantId: string) => void;
  className?: string;
}

export function TenantSwitcher({ current, options, onSwitch, className }: TenantSwitcherProps) {
  if (options.length <= 1) {
    return (
      <span className={cn('font-ui text-body-s font-medium text-text-primary', className)}>
        {current.name}
      </span>
    );
  }

  return (
    <label className={cn('flex items-center gap-2', className)}>
      <span className="sr-only">Current tenant</span>
      <select
        value={current.id}
        onChange={(event) => onSwitch(event.target.value)}
        className={cn(
          'rounded-md border border-border-hairline bg-surface-raised px-2 py-1.5',
          'font-ui text-body-s font-medium text-text-primary',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal',
        )}
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </label>
  );
}
