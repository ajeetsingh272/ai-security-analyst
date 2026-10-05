/**
 * A neutral label chip — status words that are not severity (e.g. "trial",
 * "MSP", "degraded" for a connector). Severity itself always goes through
 * SeverityPill, never this component, so a reviewer scanning for "is this
 * hue being used as the only severity signal" has one place to check.
 */
import type { ReactNode } from 'react';
import { cn } from './lib/cn.js';

export type BadgeVariant = 'neutral' | 'signal' | 'verified';

export interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  className?: string;
}

const variants: Record<BadgeVariant, string> = {
  neutral: 'bg-surface-raised text-text-secondary border-border-hairline',
  signal: 'bg-signal/10 text-signal border-signal/30',
  // Reserved exclusively for grounded evidence (TG1). Nothing else in this
  // library is allowed to pass variant="verified" — that restriction lives in
  // the call sites, not here, because the component cannot know *why* it was
  // asked to render green.
  verified: 'bg-verified/10 text-verified border-verified/30',
};

export function Badge({ children, variant = 'neutral', className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5',
        'font-ui text-label font-medium tracking-[0.04em]',
        variants[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
