'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, Badge, Skeleton, EmptyState, ErrorState } from '@sentinel/ui';
import type { DismissalDigestResponse } from '../lib/dismissals.js';

type LoadState = 'loading' | 'loaded' | 'error';

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function actorLabel(actorType: string): string {
  if (actorType === 'system') return 'Rule';
  if (actorType === 'ai') return 'Sentinel AI';
  return actorType;
}

export function DismissalDigest() {
  const [day, setDay] = useState(todayUtc());
  const [data, setData] = useState<DismissalDigestResponse | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const res = await fetch(`/api/dismissals/digest?day=${day}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`GET /dismissals/digest failed: ${res.status}`);
      setData((await res.json()) as DismissalDigestResponse);
      setLoadState('loaded');
    } catch {
      setLoadState('error');
    }
  }, [day]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="font-display text-display-m text-text-primary">Dismissals</h1>
        <label className="flex flex-col gap-1 text-body-s text-text-secondary">
          Day
          <input
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
            className="rounded-md border border-border-hairline bg-surface-raised px-2 py-1.5 text-text-primary"
          />
        </label>
      </header>

      {loadState === 'loading' && <Skeleton lines={6} />}
      {loadState === 'error' && <ErrorState title="Could not load the dismissal digest" onRetry={() => void load()} />}

      {loadState === 'loaded' && data && data.digest.length === 0 && (
        <EmptyState title="Nothing was dismissed this day" description="Dismissed cases — by a rule or by Sentinel's own triage — will be grouped here by reason." />
      )}

      {loadState === 'loaded' && data && data.digest.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Dismissal digest">
          {data.digest.map((row) => (
            <li key={`${row.actorType}-${row.reason}`}>
              <Card>
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <Badge variant={row.actorType === 'ai' ? 'signal' : 'neutral'}>{actorLabel(row.actorType)}</Badge>
                    <span className="font-ui text-body-m text-text-primary">{row.reason}</span>
                  </div>
                  <span className="font-mono text-mono-s text-text-tertiary">
                    {row.caseCount} case{row.caseCount === 1 ? '' : 's'} · {row.signalCount} signal{row.signalCount === 1 ? '' : 's'}
                  </span>
                </div>
                <a
                  href={`/cases?state=dismissed&createdAfter=${day}T00:00:00.000Z&createdBefore=${day}T23:59:59.999Z`}
                  className="mt-2 inline-block font-ui text-body-s text-signal underline underline-offset-2"
                >
                  Browse these dismissed cases →
                </a>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
