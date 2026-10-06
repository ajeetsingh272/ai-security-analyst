/**
 * The empty state of the loading/empty/error triad. Distinct from ErrorState:
 * this is "the request succeeded and there is genuinely nothing here" (no
 * open cases, no connectors yet) — a good outcome for a security product,
 * so it is deliberately calm rather than apologetic.
 */
import type { ReactNode } from 'react';
import { cn } from './lib/cn.js';

export interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, action, icon, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 rounded-lg border border-dashed border-border-hairline',
        'px-6 py-12 text-center',
        className,
      )}
    >
      {icon && <div className="text-text-tertiary">{icon}</div>}
      <p className="font-ui text-body-m font-medium text-text-primary">{title}</p>
      {description && <p className="max-w-sm text-body-s text-text-secondary">{description}</p>}
      {action}
    </div>
  );
}
