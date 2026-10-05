/**
 * The product's central visual vocabulary. Severity is communicated by hue
 * AND icon AND label, always together — this component has no variant that
 * renders hue alone, because that variant is exactly the colour-blind-safety
 * failure the token ramp was designed to prevent (see @sentinel/design-tokens
 * `severity`). A reviewer who wants "just the dot" should not be able to ask
 * this component for one.
 *
 * Icons are small inline SVGs rather than an icon-library dependency — there
 * are exactly five, their shapes are specified by the token's own `icon` key,
 * and five paths is not a reason to add a package.
 */
import { severity, type SeverityKey } from '@sentinel/design-tokens';
import { cn } from './lib/cn.js';

export interface SeverityPillProps {
  severity: SeverityKey;
  /** Compact drops the label for dense table rows; the icon and colour still carry the meaning. */
  compact?: boolean;
  className?: string;
}

const colorClass: Record<SeverityKey, string> = {
  critical: 'text-severity-critical',
  high: 'text-severity-high',
  medium: 'text-severity-medium',
  low: 'text-severity-low',
  info: 'text-severity-info',
};

function SeverityIcon({ icon }: { icon: (typeof severity)[SeverityKey]['icon'] }) {
  const common = {
    viewBox: '0 0 16 16',
    width: 14,
    height: 14,
    'aria-hidden': true as const,
    fill: 'currentColor',
  };
  switch (icon) {
    case 'octagon':
      return (
        <svg {...common}>
          <path d="M5 1h6l4 4v6l-4 4H5l-4-4V5z" />
        </svg>
      );
    case 'triangle':
      return (
        <svg {...common}>
          <path d="M8 1.5 15 14.5H1z" />
        </svg>
      );
    case 'diamond':
      return (
        <svg {...common}>
          <path d="M8 1 15 8l-7 7-7-7z" />
        </svg>
      );
    case 'circle':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.5" />
        </svg>
      );
    case 'circle-outline':
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.75">
          <circle cx="8" cy="8" r="5.75" />
        </svg>
      );
  }
}

export function SeverityPill({ severity: level, compact = false, className }: SeverityPillProps) {
  const token = severity[level];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-current/30 px-2 py-0.5',
        'font-ui text-label font-semibold tracking-[0.08em] uppercase',
        colorClass[level],
        className,
      )}
      // The icon is decorative given the text; the whole pill reads as one
      // phrase to a screen reader rather than an icon and a label separately.
      role="status"
    >
      <SeverityIcon icon={token.icon} />
      {!compact && <span>{token.label}</span>}
      {compact && <span className="sr-only">{token.label}</span>}
    </span>
  );
}
