'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, SeverityPill, Skeleton, EmptyState, ErrorState, Button } from '@sentinel/ui';
import type { ScanSummary } from '../lib/scan.js';

type LoadState = 'loading' | 'loaded' | 'error';

export interface ScanReportProps {
  scanId: string;
}

export function ScanReport({ scanId }: ScanReportProps) {
  const [data, setData] = useState<ScanSummary | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [shareState, setShareState] = useState<'idle' | 'copied'>('idle');

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const res = await fetch(`/api/scan/${scanId}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`GET /scan/${scanId} failed: ${res.status}`);
      setData((await res.json()) as ScanSummary);
      setLoadState('loaded');
    } catch {
      setLoadState('error');
    }
  }, [scanId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function share() {
    await fetch(`/api/scan/${scanId}/share`, { method: 'POST' });
    try {
      await navigator.clipboard.writeText(window.location.href);
      setShareState('copied');
    } catch {
      // Clipboard access can be denied by the browser — the share event
      // is still recorded above either way; failing to also copy the
      // URL isn't worth surfacing as an error state.
    }
  }

  if (loadState === 'loading') return <Skeleton lines={8} />;
  if (loadState === 'error') return <ErrorState title="Could not load this scan" onRetry={() => void load()} />;
  if (!data) return null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-display-m text-text-primary">Your free security scan</h1>
        <p className="text-body-s text-text-tertiary">
          Covering {new Date(data.windowStart).toLocaleDateString()} to {new Date(data.windowEnd).toLocaleDateString()}
        </p>
      </header>

      <Card className={data.isClean ? 'border-verified/30 bg-verified/10' : 'border-severity-high/30'}>
        <p className="font-ui text-body-m font-medium text-text-primary">{data.headline}</p>
      </Card>

      {data.findings.length === 0 ? (
        <EmptyState title="No activity found in this window" description="Nothing to show yet — check back after Sentinel has had a few days to watch." />
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Scan findings">
          {data.findings.map((item) => (
            <li key={item.id}>
              <Card>
                <div className="flex items-center gap-3">
                  {item.severity && <SeverityPill severity={item.severity} />}
                  <span className="font-ui text-body-s text-text-primary">{item.title ?? 'Untitled finding'}</span>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <div>
        <Button variant="secondary" onClick={() => void share()}>
          {shareState === 'copied' ? 'Link copied' : 'Copy link to share internally'}
        </Button>
      </div>
    </div>
  );
}
