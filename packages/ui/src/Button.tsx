/**
 * The baseline interactive element. Every other interactive component in this
 * library either is a Button underneath or is held to the same bar: visible
 * focus, a disabled state that is actually inert, and no colour applied
 * through anything but a token or a Tailwind utility generated from one.
 */
import { Slot } from '@radix-ui/react-slot';
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './lib/cn.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * Render the child element instead of a <button>, via Radix's Slot — the
   * standard pattern for "this needs to be a link but behave like a button."
   * The child becomes responsible for its own semantics; this is the escape
   * hatch, not the default.
   */
  asChild?: boolean;
  isLoading?: boolean;
  leadingIcon?: ReactNode;
}

const base =
  'inline-flex items-center justify-center gap-2 rounded-md font-ui font-medium ' +
  'transition-colors duration-[160ms] ease-out ' +
  // Focus is drawn, never suppressed — removing it on click is how a keyboard
  // user loses their place on the page.
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-signal disabled:pointer-events-none disabled:opacity-40';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-signal text-surface-void hover:bg-signal/90',
  secondary:
    'bg-surface-raised text-text-primary border border-border-hairline hover:border-border-strong',
  ghost: 'bg-transparent text-text-secondary hover:bg-surface-raised hover:text-text-primary',
  danger: 'bg-severity-critical text-surface-void hover:bg-severity-critical/90',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-body-s',
  md: 'h-10 px-4 text-body-m',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant = 'secondary',
    size = 'md',
    asChild = false,
    isLoading = false,
    leadingIcon,
    disabled,
    children,
    ...rest
  },
  ref,
) {
  // Slot's contract is one child element, with props merged onto it — not a
  // wrapper that can hold an icon as a sibling. asChild therefore forwards
  // children untouched; the loading spinner and leadingIcon are a <button>
  // concern, meaningful only when this component owns its own markup. Found
  // by the asChild test failing with "Slot failed to slot onto its children"
  // the first time isLoading's wrapper fragment ran through Slot.
  if (asChild) {
    return (
      <Slot
        ref={ref}
        className={cn(base, variants[variant], sizes[size], className)}
        aria-disabled={disabled || isLoading || undefined}
        {...rest}
      >
        {children}
      </Slot>
    );
  }

  return (
    <button
      ref={ref}
      className={cn(base, variants[variant], sizes[size], className)}
      disabled={disabled || isLoading}
      // A busy control that is still operable (not `disabled`) would let a
      // second click fire a duplicate action mid-request; aria-disabled alone
      // doesn't block that, so loading disables for real.
      aria-busy={isLoading || undefined}
      {...rest}
    >
      {isLoading ? (
        <span
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden="true"
        />
      ) : (
        leadingIcon
      )}
      {children}
    </button>
  );
});
