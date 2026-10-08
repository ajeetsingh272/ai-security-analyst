/**
 * Slack's OAuth v2 app-installation flow (P5-07), against the real
 * documented endpoints (https://api.slack.com/authentication/oauth-v2).
 * Mirrors m365-oauth.ts's own split (authorize URL / code exchange)
 * and its own `authorityBaseUrl`-style override for testing against a
 * local mock — this repo has no real Slack app (client id/secret) to
 * install for real, the same disclosed gap m365-oauth.ts already has
 * for Microsoft. No PKCE and no refresh token here: unlike Microsoft's
 * v2.0 endpoint, Slack's OAuth v2 bot tokens do not expire and Slack's
 * own authorize endpoint has no code_challenge parameter at all — this
 * is Slack's real contract, not an omission.
 */
const DEFAULT_SLACK_BASE_URL = 'https://slack.com';

export interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  baseUrl?: string | undefined;
}

/**
 * AC: scopes requested, documented and justified.
 * - `chat:write` — post the alert itself (title/body/Approve/Call Me
 *   First blocks) into a channel the app has been added to.
 * - `channels:read` — list channels for AC4's own per-severity routing
 *   configuration UI (a tenant picking which channel gets criticals
 *   vs. digests needs to see channel names, not just raw IDs).
 *
 * Deliberately NOT requested: anything that reads message content
 * (`channels:history`), manages the workspace, or posts as a real
 * user rather than the app's own bot identity.
 */
export const SLACK_SCOPES = ['chat:write', 'channels:read'] as const;

export class SlackOAuthError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'SlackOAuthError';
  }
}

export function buildSlackAuthorizeUrl(config: SlackOAuthConfig, state: string): string {
  const url = new URL(`${config.baseUrl ?? DEFAULT_SLACK_BASE_URL}/oauth/v2/authorize`);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('scope', SLACK_SCOPES.join(','));
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

export interface SlackInstallResult {
  botAccessToken: string;
  botUserId: string;
  teamId: string;
  teamName: string;
  scope: string;
}

interface RawOAuthAccessResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  bot_user_id?: string;
  scope?: string;
  team?: { id?: string; name?: string };
}

/** Exchanges an authorization code (from the callback) for a bot
 * access token — Slack's `oauth.v2.access`, form-encoded, no PKCE
 * verifier (see this file's own doc comment for why). */
export async function exchangeSlackCode(config: SlackOAuthConfig, code: string): Promise<SlackInstallResult> {
  const res = await fetch(`${config.baseUrl ?? DEFAULT_SLACK_BASE_URL}/api/oauth.v2.access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    }),
  });

  let parsed: RawOAuthAccessResponse;
  try {
    parsed = (await res.json()) as RawOAuthAccessResponse;
  } catch {
    throw new SlackOAuthError(`oauth.v2.access returned a non-JSON response (HTTP ${res.status})`, undefined);
  }

  if (!res.ok || !parsed.ok) {
    throw new SlackOAuthError(`oauth.v2.access failed: ${parsed.error ?? res.status}`, parsed.error);
  }
  if (!parsed.access_token || !parsed.bot_user_id || !parsed.team?.id) {
    throw new SlackOAuthError('oauth.v2.access response is missing required fields', undefined);
  }

  return {
    botAccessToken: parsed.access_token,
    botUserId: parsed.bot_user_id,
    teamId: parsed.team.id,
    teamName: parsed.team.name ?? parsed.team.id,
    scope: parsed.scope ?? SLACK_SCOPES.join(','),
  };
}
