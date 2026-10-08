'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Card, Badge, Button, Skeleton, ErrorState } from '@sentinel/ui';
import { M365_PERMISSIONS, M365_NOT_REQUESTED, type ConnectorHealth, type ConnectorsHealthResponse } from '../lib/connectors.js';

type LoadState = 'loading' | 'loaded' | 'error';

const CALLBACK_REASON_COPY: Record<string, string> = {
  consent_declined: 'The connection was cancelled before it finished — nothing was changed.',
  invalid_or_expired_state: 'That connection link had expired. Start again below.',
  invalid_callback: 'Something interrupted the connection. Start again below.',
  token_exchange_failed: "Microsoft didn't respond the way we expected. Start again below — if it keeps happening, that's worth reporting.",
};

export function ConnectorsWizard() {
  const searchParams = useSearchParams();
  const [data, setData] = useState<ConnectorsHealthResponse | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const res = await fetch('/api/connectors/health', { cache: 'no-store' });
      if (!res.ok) throw new Error(`GET /connectors/health failed: ${res.status}`);
      setData((await res.json()) as ConnectorsHealthResponse);
      setLoadState('loaded');
    } catch {
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadState === 'loading') return <Skeleton lines={6} />;
  if (loadState === 'error') return <ErrorState title="Could not load connector status" onRetry={() => void load()} />;
  if (!data) return null;

  const m365 = data.connectors.find((c) => c.kind === 'm365');
  const callbackOutcome = searchParams.get('m365');
  const callbackReason = searchParams.get('reason');

  return (
    <div className="flex flex-col gap-6">
      {callbackOutcome === 'connected' && (
        <Card role="status" className="border-verified/30 bg-verified/10">
          <p className="text-body-s text-text-primary">Microsoft 365 is connected. Sentinel will start reporting on new activity shortly.</p>
        </Card>
      )}
      {callbackOutcome === 'error' && (
        <Card role="alert" className="border-severity-critical/30 bg-severity-critical/10">
          <p className="text-body-s text-text-primary">{CALLBACK_REASON_COPY[callbackReason ?? ''] ?? 'The connection did not complete. Start again below.'}</p>
        </Card>
      )}

      {!m365 && <NotConnected />}
      {m365?.status === 'healthy' && <Connected connector={m365} onChanged={() => void load()} />}
      {m365 && (m365.status === 'degraded' || m365.status === 'pending') && <NeedsAttention connector={m365} />}
    </div>
  );
}

function NotConnected() {
  return (
    <section aria-label="Connect Microsoft 365" className="flex flex-col gap-4">
      <h2 className="font-ui text-body-m font-semibold text-text-primary">Connect Microsoft 365</h2>
      <p className="text-body-s text-text-secondary">
        This takes about two minutes. You&apos;ll be asked to sign in as a Microsoft 365 admin and approve the permissions below — Sentinel starts
        watching for real security signals as soon as you do.
      </p>

      <div className="flex flex-col gap-3">
        {M365_PERMISSIONS.map((p) => (
          <Card key={p.scope}>
            <p className="font-ui text-body-s font-medium text-text-primary">{p.plain}</p>
            <p className="mt-1 text-body-s text-text-secondary">{p.why}</p>
          </Card>
        ))}
      </div>

      <div>
        <p className="font-ui text-body-s font-medium text-text-secondary">Sentinel never asks for:</p>
        <ul className="mt-1 flex flex-col gap-1 pl-5 text-body-s text-text-tertiary">
          {M365_NOT_REQUESTED.map((item) => (
            <li key={item} className="list-disc">
              {item}
            </li>
          ))}
        </ul>
      </div>

      <Button asChild variant="primary">
        <a href="/api/connectors/m365/connect">Connect Microsoft 365</a>
      </Button>
    </section>
  );
}

function Connected({ connector, onChanged }: { connector: ConnectorHealth; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  async function disconnect() {
    setDisconnecting(true);
    try {
      await fetch('/api/connectors/m365/revoke', { method: 'POST' });
      onChanged();
    } finally {
      setDisconnecting(false);
      setConfirming(false);
    }
  }

  return (
    <section aria-label="Microsoft 365 connection status" className="flex flex-col gap-3">
      <Card>
        <div className="flex items-center justify-between">
          <span className="font-ui text-body-s font-medium text-text-primary">Microsoft 365</span>
          <Badge variant="verified">Connected</Badge>
        </div>
        <p className="mt-2 text-body-s text-text-secondary">
          {connector.lastSyncAt ? `Last synced ${new Date(connector.lastSyncAt).toLocaleString()}` : 'Waiting for the first sync.'}
        </p>
      </Card>

      {!confirming && (
        <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
          Disconnect
        </Button>
      )}

      {confirming && (
        <Card className="border-severity-critical/30">
          <p className="font-ui text-body-s font-medium text-text-primary">Disconnecting will:</p>
          <ul className="mt-1 flex flex-col gap-1 pl-5 text-body-s text-text-secondary">
            <li className="list-disc">Stop reading new sign-in and admin activity from Microsoft 365 immediately.</li>
            <li className="list-disc">Leave every case Sentinel has already created exactly as it is.</li>
            <li className="list-disc">Not affect anything inside Microsoft 365 itself — nothing there changes.</li>
          </ul>
          <p className="mt-2 text-body-s text-text-secondary">You can reconnect at any time.</p>
          <div className="mt-3 flex gap-2">
            <Button variant="danger" size="sm" isLoading={disconnecting} onClick={() => void disconnect()}>
              Yes, disconnect
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}
    </section>
  );
}

const RECOVERY_COPY: Record<string, string> = {
  revoked: 'Microsoft 365 access was turned off — reconnect below to resume collecting sign-in and admin activity.',
  error: "Sentinel couldn't reach Microsoft 365 on its last attempt. Reconnecting usually fixes this.",
};

function NeedsAttention({ connector }: { connector: ConnectorHealth }) {
  const message = (connector.reason && RECOVERY_COPY[connector.reason]) ?? "This connection needs attention — reconnecting should resolve it.";
  return (
    <section aria-label="Microsoft 365 connection needs attention" className="flex flex-col gap-3">
      <Card role="alert" className="border-severity-high/30">
        <div className="flex items-center justify-between">
          <span className="font-ui text-body-s font-medium text-text-primary">Microsoft 365</span>
          <Badge variant="neutral">Needs attention</Badge>
        </div>
        <p className="mt-2 text-body-s text-text-secondary">{message}</p>
      </Card>
      <Button asChild variant="primary">
        <a href="/api/connectors/m365/connect">Reconnect Microsoft 365</a>
      </Button>
    </section>
  );
}
