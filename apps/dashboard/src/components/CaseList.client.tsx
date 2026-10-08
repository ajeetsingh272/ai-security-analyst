'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Card, SeverityPill, Badge, Skeleton, EmptyState, ErrorState, Pagination } from '@sentinel/ui';
import {
  SEVERITIES,
  STATES,
  buildCasesQuery,
  type CaseListItem,
  type CaseListResponse,
  type CaseFilterOptions,
  type CaseFilters,
} from '../lib/cases.js';

const PAGE_SIZE = 25;
// T2's own requirement is "without a manual refresh," not "in real
// time" — polling is the honest, simple way to satisfy that literally;
// see this component's own module-level comment below for why this
// wasn't built as a push-based (SSE/WebSocket) feed instead.
const POLL_INTERVAL_MS = 3000;

type LoadState = 'loading' | 'loaded' | 'error';

/**
 * Live updates (AC2/T2) are polling, not a push feed. A real push
 * mechanism (Server-Sent Events or a WebSocket relaying the `cases`
 * Kafka topic services/correlate already publishes to) does not exist
 * anywhere in this repo yet — building that relay from scratch was out
 * of this ticket's own scope, and polling satisfies the AC's literal
 * wording ("new cases appear without a manual refresh") honestly rather
 * than faking a push feed that isn't real.
 */
/** P6-08: the dismissal digest links here with `?state=dismissed&
 * createdAfter=...&createdBefore=...` so "browsable" dismissals
 * actually land on a pre-filtered list rather than a plain, unfiltered
 * /cases page the user would have to re-filter by hand. */
function initialFiltersFromSearchParams(params: URLSearchParams): CaseFilters {
  const filters: CaseFilters = {};
  for (const key of ['severity', 'state', 'entityId', 'ruleId', 'createdAfter', 'createdBefore'] as const) {
    const value = params.get(key);
    if (value) filters[key] = value;
  }
  return filters;
}

export function CaseList() {
  const searchParams = useSearchParams();
  const [filters, setFilters] = useState<CaseFilters>(() => initialFiltersFromSearchParams(searchParams));
  const [page, setPage] = useState(1);
  const [data, setData] = useState<CaseListResponse | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [filterOptions, setFilterOptions] = useState<CaseFilterOptions>({ entities: [], rules: [] });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);

  const load = useCallback(async (isPoll: boolean) => {
    if (!isPoll) setLoadState('loading');
    try {
      const res = await fetch(buildCasesQuery(filters, page, PAGE_SIZE), { cache: 'no-store' });
      if (!res.ok) throw new Error(`GET /cases failed: ${res.status}`);
      const body = (await res.json()) as CaseListResponse;
      setData(body);
      setLoadState('loaded');
    } catch {
      if (!isPoll) setLoadState('error');
      // A failed background poll leaves the last good page on screen
      // rather than replacing it with an error state — a transient
      // network blip shouldn't interrupt someone reading the list.
    }
  }, [filters, page]);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    const interval = setInterval(() => void load(true), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    fetch('/api/cases/filter-options', { cache: 'no-store' })
      .then((res) => (res.ok ? (res.json() as Promise<CaseFilterOptions>) : null))
      .then((body) => body && setFilterOptions(body))
      .catch(() => {});
  }, []);

  function updateFilter<K extends keyof CaseFilters>(key: K, value: string) {
    setPage(1);
    setFilters((prev) => ({ ...prev, [key]: value || undefined }));
  }

  function handleRowKeyDown(event: React.KeyboardEvent<HTMLDivElement>, index: number) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      rowRefs.current[index + 1]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      rowRefs.current[index - 1]?.focus();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-wrap gap-3 border-0 p-0" aria-label="Filter cases">
        <label className="flex flex-col gap-1 text-body-s text-text-secondary">
          Severity
          <select
            value={filters.severity ?? ''}
            onChange={(e) => updateFilter('severity', e.target.value)}
            className="rounded-md border border-border-hairline bg-surface-raised px-2 py-1.5 text-text-primary"
          >
            <option value="">Any</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-body-s text-text-secondary">
          Status
          <select
            value={filters.state ?? ''}
            onChange={(e) => updateFilter('state', e.target.value)}
            className="rounded-md border border-border-hairline bg-surface-raised px-2 py-1.5 text-text-primary"
          >
            <option value="">Any</option>
            {STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-body-s text-text-secondary">
          Entity
          <select
            value={filters.entityId ?? ''}
            onChange={(e) => updateFilter('entityId', e.target.value)}
            className="rounded-md border border-border-hairline bg-surface-raised px-2 py-1.5 text-text-primary"
          >
            <option value="">Any</option>
            {filterOptions.entities.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-body-s text-text-secondary">
          Rule
          <select
            value={filters.ruleId ?? ''}
            onChange={(e) => updateFilter('ruleId', e.target.value)}
            className="rounded-md border border-border-hairline bg-surface-raised px-2 py-1.5 text-text-primary"
          >
            <option value="">Any</option>
            {filterOptions.rules.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-body-s text-text-secondary">
          Created after
          <input
            type="date"
            value={filters.createdAfter?.slice(0, 10) ?? ''}
            onChange={(e) => updateFilter('createdAfter', e.target.value)}
            className="rounded-md border border-border-hairline bg-surface-raised px-2 py-1.5 text-text-primary"
          />
        </label>

        <label className="flex flex-col gap-1 text-body-s text-text-secondary">
          Created before
          <input
            type="date"
            value={filters.createdBefore?.slice(0, 10) ?? ''}
            onChange={(e) => updateFilter('createdBefore', e.target.value)}
            className="rounded-md border border-border-hairline bg-surface-raised px-2 py-1.5 text-text-primary"
          />
        </label>
      </fieldset>

      {loadState === 'loading' && <Skeleton lines={6} />}

      {loadState === 'error' && <ErrorState title="Could not load cases" onRetry={() => void load(false)} />}

      {loadState === 'loaded' && data && data.items.length === 0 && (
        <EmptyState title="No cases match these filters" description="Try widening the severity, status, entity, rule or date range." />
      )}

      {loadState === 'loaded' && data && data.items.length > 0 && (
        <>
          <ul className="flex flex-col gap-2" aria-label="Cases">
            {data.items.map((item: CaseListItem, index: number) => {
              const expanded = expandedId === item.id;
              return (
                <li key={item.id}>
                  <Card
                    ref={(el: HTMLDivElement | null) => {
                      rowRefs.current[index] = el;
                    }}
                    onClick={() => setExpandedId(expanded ? null : item.id)}
                    onKeyDown={(e) => handleRowKeyDown(e, index)}
                    aria-expanded={expanded}
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        {item.severity && <SeverityPill severity={item.severity} />}
                        <span className="font-ui text-body-m text-text-primary">{item.title ?? 'Untitled case'}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        {item.state && <Badge variant="neutral">{item.state}</Badge>}
                        <span className="font-mono text-mono-s text-text-tertiary">{item.score?.toFixed(1) ?? '—'}</span>
                      </div>
                    </div>
                    {expanded && (
                      <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border-hairline pt-3 text-body-s text-text-secondary">
                        <dt>Signals</dt>
                        <dd>{item.signalCount}</dd>
                        <dt>Entities involved</dt>
                        <dd>{item.entityIds.length}</dd>
                        <dt>Window start</dt>
                        <dd>{new Date(item.windowStart).toLocaleString()}</dd>
                        <dt>Window end</dt>
                        <dd>{item.windowEnd ? new Date(item.windowEnd).toLocaleString() : 'still open'}</dd>
                      </dl>
                    )}
                    {expanded && (
                      <a
                        href={`/cases/${item.id}`}
                        className="mt-2 inline-block font-ui text-body-s text-signal underline underline-offset-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        View full case →
                      </a>
                    )}
                  </Card>
                </li>
              );
            })}
          </ul>

          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
        </>
      )}
    </div>
  );
}
