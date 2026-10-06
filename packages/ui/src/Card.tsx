/**
 * The base container for data-bearing surfaces — a case summary, a connector
 * row, a report section. Non-interactive by default: a `<div>` needs no
 * keyboard handling because it does nothing on its own.
 *
 * Passing `onClick` switches it into an interactive card, and that switch
 * carries full keyboard semantics with it — `role="button"`, `tabIndex`,
 * and Enter/Space activation — rather than leaving a clickable div that a
 * keyboard user cannot reach. A mouse-only "clickable card" is the single most
 * common accessibility regression in dashboard UI, which is why this is
 * handled once, here, instead of at every call site that wants one.
 */
import { forwardRef } from 'react';
import type { HTMLAttributes, KeyboardEvent, MouseEvent, MouseEventHandler } from 'react';
import { cn } from './lib/cn.js';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  onClick?: MouseEventHandler<HTMLDivElement>;
  density?: 'comfortable' | 'compact';
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, onClick, density = 'comfortable', onKeyDown, children, ...rest },
  ref,
) {
  const interactive = Boolean(onClick);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(event);
    if (!interactive) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick?.(event as unknown as MouseEvent<HTMLDivElement>);
    }
  }

  return (
    <div
      ref={ref}
      className={cn(
        'rounded-lg border border-border-hairline bg-surface-raised',
        density === 'compact' ? 'p-4' : 'p-6',
        interactive &&
          'cursor-pointer transition-colors duration-[160ms] hover:border-border-strong ' +
            'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal',
        className,
      )}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      {...rest}
    >
      {children}
    </div>
  );
});
