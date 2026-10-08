/**
 * Presentational dark/light switch. Holds no state and touches neither
 * `document` nor a cookie itself — the repo's theme mechanism is a
 * `data-theme` attribute contract (see @sentinel/design-tokens), and
 * actually mutating that attribute plus persisting the choice is a
 * "use client" concern that belongs in the consuming app (apps/dashboard),
 * not in this framework-agnostic package.
 */
import { cn } from './lib/cn.js';

export interface ThemeToggleButtonProps {
  theme: 'dark' | 'light';
  onToggle: () => void;
  className?: string;
}

export function ThemeToggleButton({ theme, onToggle, className }: ThemeToggleButtonProps) {
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className={cn(
        'inline-flex h-10 w-10 items-center justify-center rounded-md',
        'text-text-secondary hover:bg-surface-raised hover:text-text-primary',
        'transition-colors duration-[160ms]',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal',
        className,
      )}
    >
      <span aria-hidden="true">{isDark ? '☀' : '☾'}</span>
    </button>
  );
}
