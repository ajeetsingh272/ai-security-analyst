/**
 * The error state of the loading/empty/error triad. Distinct from EmptyState:
 * this is "the request failed," which is bad news and gets the critical
 * severity colour plus a retry action — never silently rendered as if there
 * were just nothing to show, which hides a real outage from the person
 * watching the dashboard.
 */
import { cn } from './lib/cn.js';
import { Button } from './Button.js';

export interface ErrorStateProps {
  title: string;
  description?: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({ title, description, onRetry, className }: ErrorStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 rounded-lg border border-severity-critical/30',
        'bg-severity-critical/5 px-6 py-12 text-center',
        className,
      )}
      role="alert"
    >
      <p className="font-ui text-body-m font-medium text-severity-critical">{title}</p>
      {description && <p className="max-w-sm text-body-s text-text-secondary">{description}</p>}
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
