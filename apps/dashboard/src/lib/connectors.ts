/** Mirrors GET /connectors/health's response shape
 * (apps/api/src/routes/connectors.ts / connectors-repository.ts) — this
 * app's own wire-contract mirror, same reasoning as lib/session.ts. */

export type ConnectorApiStatus = 'pending' | 'healthy' | 'degraded';

export interface ConnectorHealth {
  id: string;
  kind: string;
  status: ConnectorApiStatus;
  /** The RAW db status ('revoked', 'error', ...) when it's been
   * collapsed into 'degraded' for the simplified `status` field above —
   * null when status wasn't collapsed. */
  reason: string | null;
  lastError: string | null;
  lastSyncAt: string | null;
  lagSeconds: number;
}

export interface ConnectorsHealthResponse {
  connectors: ConnectorHealth[];
}

/** The real, literal scopes apps/api/src/connectors/m365-oauth.ts
 * requests (M365_SCOPES) — kept in sync by hand since the dashboard has
 * no reason to depend on apps/api's own module tree (two independently
 * deployable processes, same reasoning as lib/session.ts's Role type).
 * If that list ever changes, this one needs updating too. */
export const M365_PERMISSIONS = [
  {
    scope: 'ActivityFeed.Read',
    plain: 'Read your Microsoft 365 activity logs — sign-ins, admin changes, and mailbox rule changes across Exchange, SharePoint and Azure AD.',
    why: "This is the data Sentinel actually watches for the signals it reports on. It's read-only — nothing is ever changed through this permission.",
  },
  {
    scope: 'ActivityFeed.ReadDlp',
    plain: 'Read the data-loss-prevention (DLP) slice of those same activity logs.',
    why: 'DLP events (e.g. a sensitive file matching a policy) are some of the clearest signs of real data exfiltration — this is a narrower, separate permission Microsoft requires for that specific feed.',
  },
  {
    scope: 'offline_access',
    plain: 'Stay connected without you having to sign in again every hour.',
    why: "This isn't an API permission by itself — it's what lets Sentinel keep watching continuously instead of needing a human to re-authorize it constantly.",
  },
] as const;

/** What Sentinel explicitly does NOT ask for — shown alongside the real
 * list above so "read your activity logs" doesn't read as a blank
 * check. */
export const M365_NOT_REQUESTED = [
  'Reading or sending email content',
  'Reading files in OneDrive or SharePoint',
  'Changing any setting in your Microsoft 365 tenant',
] as const;
