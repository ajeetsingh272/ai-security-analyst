'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, Badge, Button, Skeleton, ErrorState } from '@sentinel/ui';
import {
  M365_PERMISSIONS,
  M365_NOT_REQUESTED,
  GOOGLE_PERMISSIONS,
  GOOGLE_NOT_REQUESTED,
  type ConnectorHealth,
  type ConnectorsHealthResponse,
} from '../lib/connectors.js';
import type { ScanSummary } from '../lib/scan.js';

type LoadState = 'loading' | 'loaded' | 'error';

/** P7-01: one config per identity-platform connector — M365 was the only
 * one of these until now, so its own copy/endpoints were hardcoded
 * directly into NotConnected/Connected/NeedsAttention below. Adding a
 * second REAL consumer (not a speculative one) is what justifies
 * parameterizing those three functions now rather than duplicating them. */
interface ConnectorWizardConfig {
  kind: string;
  /** The query-string key each connector's own OAuth callback redirects
   * with (routes/m365-connector.ts uses `m365`, routes/google-connector.ts
   * uses `google`) — kept per-connector rather than shared, so two
   * connectors completing their flows back to back never collide on the
   * same param. */
  queryParam: string;
  vendorLabel: string;
  connectPath: string;
  revokePath: string;
  permissions: ReadonlyArray<{ scope: string; plain: string; why: string }>;
  notRequested: readonly string[];
}

const M365_CONFIG: ConnectorWizardConfig = {
  kind: 'm365',
  queryParam: 'm365',
  vendorLabel: 'Microsoft 365',
  connectPath: '/api/connectors/m365/connect',
  revokePath: '/api/connectors/m365/revoke',
  permissions: M365_PERMISSIONS,
  notRequested: M365_NOT_REQUESTED,
};

const GOOGLE_CONFIG: ConnectorWizardConfig = {
  kind: 'google_workspace',
  queryParam: 'google',
  vendorLabel: 'Google Workspace',
  connectPath: '/api/connectors/google/connect',
  revokePath: '/api/connectors/google/revoke',
  permissions: GOOGLE_PERMISSIONS,
  notRequested: GOOGLE_NOT_REQUESTED,
};

function callbackReasonCopy(vendorLabel: string, reason: string | null): string {
  switch (reason) {
    case 'consent_declined':
      return 'The connection was cancelled before it finished — nothing was changed.';
    case 'invalid_or_expired_state':
      return 'That connection link had expired. Start again below.';
    case 'invalid_callback':
      return 'Something interrupted the connection. Start again below.';
    case 'token_exchange_failed':
      return `${vendorLabel} didn't respond the way we expected. Start again below — if it keeps happening, that's worth reporting.`;
    default:
      return 'The connection did not complete. Start again below.';
  }
}

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

  // P6-11: the page-level heading renders in every state — a real gap
  // found by this ticket's own e2e axe scan on a sibling component
  // (MspConsole): returning the loading/error state before ever
  // reaching the heading below left those states with no level-one
  // heading at all.
  const heading = <h1 className="font-display text-display-m text-text-primary">Connectors</h1>;
  if (loadState === 'loading') {
    return (
      <div className="flex flex-col gap-6">
        {heading}
        <Skeleton lines={6} />
      </div>
    );
  }
  if (loadState === 'error') {
    return (
      <div className="flex flex-col gap-6">
        {heading}
        <ErrorState title="Could not load connector status" onRetry={() => void load()} />
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="flex flex-col gap-10">
      {heading}
      <ConnectorSection config={M365_CONFIG} data={data} searchParams={searchParams} onChanged={() => void load()} />
      <ConnectorSection config={GOOGLE_CONFIG} data={data} searchParams={searchParams} onChanged={() => void load()} />
    </div>
  );
}

function ConnectorSection({
  config,
  data,
  searchParams,
  onChanged,
}: {
  config: ConnectorWizardConfig;
  data: ConnectorsHealthResponse;
  searchParams: ReturnType<typeof useSearchParams>;
  onChanged: () => void;
}) {
  const connector = data.connectors.find((c) => c.kind === config.kind);
  const callbackOutcome = searchParams.get(config.queryParam);
  const callbackReason = searchParams.get('reason');

  return (
    <div className="flex flex-col gap-4">
      {callbackOutcome === 'connected' && (
        <Card role="status" className="border-verified/30 bg-verified/10">
          <p className="text-body-s text-text-primary">{config.vendorLabel} is connected. Sentinel will start reporting on new activity shortly.</p>
        </Card>
      )}
      {callbackOutcome === 'error' && (
        <Card role="alert" className="border-severity-critical/30 bg-severity-critical/10">
          <p className="text-body-s text-text-primary">{callbackReasonCopy(config.vendorLabel, callbackReason)}</p>
        </Card>
      )}

      {!connector && <NotConnected config={config} />}
      {connector?.status === 'healthy' && <Connected config={config} connector={connector} onChanged={onChanged} />}
      {connector && (connector.status === 'degraded' || connector.status === 'pending') && <NeedsAttention config={config} connector={connector} />}
    </div>
  );
}

function NotConnected({ config }: { config: ConnectorWizardConfig }) {
  return (
    <section aria-label={`Connect ${config.vendorLabel}`} className="flex flex-col gap-4">
      <h2 className="font-ui text-body-m font-semibold text-text-primary">Connect {config.vendorLabel}</h2>
      <p className="text-body-s text-text-secondary">
        This takes about two minutes. You&apos;ll be asked to sign in as a {config.vendorLabel} admin and approve the permissions below — Sentinel
        starts watching for real security signals as soon as you do.
      </p>

      <div className="flex flex-col gap-3">
        {config.permissions.map((p) => (
          <Card key={p.scope}>
            <p className="font-ui text-body-s font-medium text-text-primary">{p.plain}</p>
            <p className="mt-1 text-body-s text-text-secondary">{p.why}</p>
          </Card>
        ))}
      </div>

      <div>
        <p className="font-ui text-body-s font-medium text-text-secondary">Sentinel never asks for:</p>
        <ul className="mt-1 flex flex-col gap-1 pl-5 text-body-s text-text-tertiary">
          {config.notRequested.map((item) => (
            <li key={item} className="list-disc">
              {item}
            </li>
          ))}
        </ul>
      </div>

      <Button asChild variant="primary">
        <a href={config.connectPath}>Connect {config.vendorLabel}</a>
      </Button>
    </section>
  );
}

function Connected({ config, connector, onChanged }: { config: ConnectorWizardConfig; connector: ConnectorHealth; onChanged: () => void }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [scanning, setScanning] = useState(false);

  async function startScan() {
    setScanning(true);
    try {
      const res = await fetch('/api/scan', { method: 'POST' });
      if (!res.ok) return;
      const { scanId } = (await res.json()) as ScanSummary;
      router.push(`/connectors/scan/${scanId}`);
    } finally {
      setScanning(false);
    }
  }

  async function disconnect() {
    setDisconnecting(true);
    try {
      await fetch(config.revokePath, { method: 'POST' });
      onChanged();
    } finally {
      setDisconnecting(false);
      setConfirming(false);
    }
  }

  return (
    <section aria-label={`${config.vendorLabel} connection status`} className="flex flex-col gap-3">
      <Card>
        <div className="flex items-center justify-between">
          <span className="font-ui text-body-s font-medium text-text-primary">{config.vendorLabel}</span>
          <Badge variant="verified">Connected</Badge>
        </div>
        <p className="mt-2 text-body-s text-text-secondary">
          {connector.lastSyncAt ? `Last synced ${new Date(connector.lastSyncAt).toLocaleString()}` : 'Waiting for the first sync.'}
        </p>
      </Card>

      {!confirming && (
        <div className="flex gap-2">
          <Button variant="primary" size="sm" isLoading={scanning} onClick={() => void startScan()}>
            Run a free scan
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
            Disconnect
          </Button>
        </div>
      )}

      {confirming && (
        <Card className="border-severity-critical/30">
          <p className="font-ui text-body-s font-medium text-text-primary">Disconnecting will:</p>
          <ul className="mt-1 flex flex-col gap-1 pl-5 text-body-s text-text-secondary">
            <li className="list-disc">Stop reading new sign-in and admin activity from {config.vendorLabel} immediately.</li>
            <li className="list-disc">Leave every case Sentinel has already created exactly as it is.</li>
            <li className="list-disc">Not affect anything inside {config.vendorLabel} itself — nothing there changes.</li>
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

const RECOVERY_COPY: Record<string, (vendorLabel: string) => string> = {
  revoked: (vendorLabel) => `${vendorLabel} access was turned off — reconnect below to resume collecting sign-in and admin activity.`,
  error: (vendorLabel) => `Sentinel couldn't reach ${vendorLabel} on its last attempt. Reconnecting usually fixes this.`,
};

function NeedsAttention({ config, connector }: { config: ConnectorWizardConfig; connector: ConnectorHealth }) {
  const message = (connector.reason && RECOVERY_COPY[connector.reason]?.(config.vendorLabel)) ?? 'This connection needs attention — reconnecting should resolve it.';
  return (
    <section aria-label={`${config.vendorLabel} connection needs attention`} className="flex flex-col gap-3">
      <Card role="alert" className="border-severity-high/30">
        <div className="flex items-center justify-between">
          <span className="font-ui text-body-s font-medium text-text-primary">{config.vendorLabel}</span>
          <Badge variant="neutral">Needs attention</Badge>
        </div>
        <p className="mt-2 text-body-s text-text-secondary">{message}</p>
      </Card>
      <Button asChild variant="primary">
        <a href={config.connectPath}>Reconnect {config.vendorLabel}</a>
      </Button>
    </section>
  );
}
