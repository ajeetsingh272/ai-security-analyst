'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, Badge, Skeleton, EmptyState, ErrorState, Button } from '@sentinel/ui';
import type { SuppressionListResponse, SuppressionRow } from '../lib/suppressions.js';

type LoadState = 'loading' | 'loaded' | 'error';

export interface SuppressionListProps {
  /** AC/role-gating: revoking is an analyst+ action within an
   * otherwise read_only-visible list, same pattern as P6-07's
   * "generate now"/schedule controls. */
  canManage: boolean;
}

function SuppressionCard({ suppression, canManage, onRevoked }: { suppression: SuppressionRow; canManage: boolean; onRevoked: () => void }) {
  const [revoking, setRevoking] = useState(false);

  async function revoke() {
    setRevoking(true);
    try {
      const res = await fetch(`/api/suppressions/${suppression.id}/revoke`, { method: 'POST' });
      if (res.ok) onRevoked();
    } finally {
      setRevoking(false);
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="font-ui text-body-m font-medium text-text-primary">{suppression.ruleId}</p>
          <p className="text-body-s text-text-secondary">{suppression.entityId ? `Scoped to ${suppression.entityId}` : 'Every entity'}</p>
        </div>
        <Badge variant="neutral">{suppression.suppressedCount} suppressed</Badge>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border-hairline pt-3 text-body-s text-text-secondary">
        <dt>Reason</dt>
        <dd>{suppression.reason}</dd>
        <dt>Created by</dt>
        <dd>{suppression.createdByEmail ?? suppression.createdBy}</dd>
        <dt>Expires</dt>
        <dd>{new Date(suppression.expiresAt).toLocaleString()}</dd>
      </dl>
      {canManage && (
        <div className="mt-3 border-t border-border-hairline pt-3">
          <Button variant="secondary" size="sm" isLoading={revoking} onClick={() => void revoke()}>
            Revoke
          </Button>
        </div>
      )}
    </Card>
  );
}

export function SuppressionList({ canManage }: SuppressionListProps) {
  const [data, setData] = useState<SuppressionListResponse | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const res = await fetch('/api/suppressions', { cache: 'no-store' });
      if (!res.ok) throw new Error(`GET /suppressions failed: ${res.status}`);
      setData((await res.json()) as SuppressionListResponse);
      setLoadState('loaded');
    } catch {
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadState === 'loading') return <Skeleton lines={6} />;
  if (loadState === 'error') return <ErrorState title="Could not load suppressions" onRetry={() => void load()} />;
  if (!data) return null;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-display text-display-m text-text-primary">Active suppressions</h1>

      {data.suppressions.length === 0 ? (
        <EmptyState title="No active suppressions" description="A suppression silences a noisy rule for a bounded time — none are currently in effect for this tenant." />
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Active suppressions">
          {data.suppressions.map((s) => (
            <li key={s.id}>
              <SuppressionCard suppression={s} canManage={canManage} onRevoked={() => void load()} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
