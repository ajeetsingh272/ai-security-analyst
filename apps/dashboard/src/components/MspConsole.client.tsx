'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Badge, Skeleton, EmptyState, ErrorState } from '@sentinel/ui';
import type { MspClientsResponse } from '../lib/msp.js';

type LoadState = 'loading' | 'loaded' | 'error';

export function MspConsole() {
  const router = useRouter();
  const [data, setData] = useState<MspClientsResponse | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [query, setQuery] = useState('');
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const res = await fetch('/api/msp/clients', { cache: 'no-store' });
      if (!res.ok) throw new Error(`GET /msp/clients failed: ${res.status}`);
      setData((await res.json()) as MspClientsResponse);
      setLoadState('loaded');
    } catch {
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // AC3: cross-client search, scoped to only linked clients — the
  // server's own response already IS that scope, so filtering it
  // client-side (at this ticket's own 200-client ceiling) is a plain
  // substring match, not a separate search endpoint.
  const filtered = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    if (!q) return data.clients;
    return data.clients.filter((c) => c.name.toLowerCase().includes(q));
  }, [data, query]);

  async function drillInto(tenantId: string) {
    setSwitchingId(tenantId);
    try {
      const res = await fetch('/api/auth/switch-tenant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetTenantId: tenantId }),
      });
      if (res.ok) {
        router.push('/cases');
        // Without this, the (app) layout's own header (the tenant
        // switcher — AC2's "visibly" half) keeps showing the pre-switch
        // tenant: a client-side push navigation to a sibling route
        // under the same shared layout does not by itself refetch that
        // layout's own server-side session read. TenantSwitcherClient's
        // own switch handler (P6-01) does this same refresh for the
        // identical reason.
        router.refresh();
      }
    } finally {
      setSwitchingId(null);
    }
  }

  // P6-11: the page-level heading renders in EVERY state, not only
  // once data has loaded — a real gap found by this ticket's own e2e
  // axe scan: a tenant with no linked clients yet (the common case for
  // most admin accounts) landed on a page with no level-one heading at
  // all, since the old code returned the empty state before ever
  // reaching the heading below it.
  if (loadState === 'loading') {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="font-display text-display-m text-text-primary">Clients</h1>
        <Skeleton lines={6} />
      </div>
    );
  }
  if (loadState === 'error') {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="font-display text-display-m text-text-primary">Clients</h1>
        <ErrorState title="Could not load your clients" onRetry={() => void load()} />
      </div>
    );
  }
  if (!data) return null;

  if (data.clients.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="font-display text-display-m text-text-primary">Clients</h1>
        <EmptyState title="No linked clients yet" description="Clients you're linked to as an MSP will appear here, ranked by what needs attention most." />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-display-m text-text-primary">Clients</h1>
      <label className="flex flex-col gap-1">
        <span className="font-ui text-body-s font-medium text-text-secondary">Search clients</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by client name"
          className="rounded-md border border-border-hairline bg-surface-raised px-3 py-2 text-body-m text-text-primary"
        />
      </label>

      <ul className="flex flex-col gap-2" aria-label="Linked clients">
        {filtered.map((client) => (
          <li key={client.tenantId}>
            <Card onClick={() => void drillInto(client.tenantId)} aria-label={`Open ${client.name}`}>
              <div className="flex items-center justify-between gap-4">
                <span className="font-ui text-body-s font-medium text-text-primary">{client.name}</span>
                <Badge variant={client.openCriticalCount > 0 ? 'signal' : 'neutral'}>
                  {client.openCriticalCount} open critical{client.openCriticalCount === 1 ? '' : 's'}
                </Badge>
              </div>
              {switchingId === client.tenantId && <p className="mt-1 text-body-s text-text-tertiary">Switching…</p>}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
