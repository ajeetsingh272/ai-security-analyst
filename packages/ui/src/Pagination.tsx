/**
 * Previous/next pagination for a server-paged list — deliberately not
 * numbered page links, since a severity-ranked list that live-updates
 * (P6-02) can shift which rows are on which page between requests; "go
 * to page 7 specifically" promises a stability this data doesn't have.
 */
import { Button } from './Button.js';
import { cn } from './lib/cn.js';

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  className?: string;
}

export function Pagination({ page, pageSize, total, onPageChange, className }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className={cn('flex items-center justify-between gap-4 font-ui text-body-s text-text-secondary', className)}>
      <span role="status">
        Page {page} of {totalPages} ({total} total)
      </span>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          Previous
        </Button>
        <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}
