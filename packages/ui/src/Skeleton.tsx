/**
 * The loading state of the loading/empty/error triad (P0-08 AC5). A
 * data-bearing component renders one of Skeleton, EmptyState or ErrorState
 * instead of its real content while data is pending, absent, or failed —
 * kept as separate components rather than built into each container, so the
 * pattern is consistent everywhere a case list, connector table or report
 * section can be in one of these states.
 */
import { cn } from './lib/cn.js';

export interface SkeletonProps {
  className?: string;
  /** Number of stacked lines, for list/table placeholders. */
  lines?: number;
}

export function Skeleton({ className, lines = 1 }: SkeletonProps) {
  if (lines > 1) {
    return (
      <div className="flex flex-col gap-2" role="status" aria-label="Loading">
        {Array.from({ length: lines }, (_, i) => (
          // Spread conditionally rather than `className={className}`: with
          // exactOptionalPropertyTypes, an optional prop may be omitted or a
          // string, never explicitly `undefined` — which is what passing the
          // possibly-undefined variable directly would do.
          <Skeleton key={i} {...(className !== undefined ? { className } : {})} />
        ))}
      </div>
    );
  }
  return (
    <div
      className={cn(
        'animate-pulse rounded-md bg-surface-raised',
        // prefers-reduced-motion disables animation globally in theme.css;
        // the shape itself still communicates "loading" without the pulse.
        className,
      )}
      role="status"
      aria-label="Loading"
    />
  );
}
