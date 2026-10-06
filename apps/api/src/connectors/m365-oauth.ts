/**
 * The Microsoft 365 admin-consent OAuth2 client (P1-02) — authorize URL,
 * authorization-code exchange, and refresh-token exchange, against the
 * real Microsoft identity platform v2.0 endpoints
 * (https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oauth-code).
 *
 * `authorityBaseUrl` is deliberately configurable, not hardcoded to
 * Microsoft's real hostname: this repo has no real Entra app registration
 * yet (client id/secret, P1-02's own T1 — "full consent flow against a
 * Microsoft test tenant" — is the one thing this ticket cannot prove
 * without one). Every OTHER requirement here — the authorize URL's exact
 * shape, PKCE, the token exchange request/response contract, refresh, and
 * revoked-consent detection — is tested against a LOCAL mock server that
 * returns exactly what Microsoft's own docs specify, by pointing this
 * same code at `http://localhost:.../` instead. Swapping back to the real
 * endpoint the moment real credentials exist is a config change, not a
 * rewrite.
 */
import { createHash } from 'node:crypto';

const DEFAULT_AUTHORITY = 'https://login.microsoftonline.com';

export interface M365OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorityBaseUrl?: string | undefined;
}

/**
 * AC1: "Only read-only scopes are requested; the requested scope list is
 * documented and justified in the repo." This IS that documentation.
 *
 * - `ActivityFeed.Read` — read-only access to the Office 365 Management
 *   Activity API's audit content (Exchange, SharePoint, Azure AD, General).
 * - `ActivityFeed.ReadDlp` — read-only access to the DLP-specific slice of
 *   that same feed (part of Audit.General's content, scoped separately by
 *   Microsoft).
 * - `offline_access` — required to receive a refresh token at all; without
 *   it, Microsoft issues only a short-lived access token with no way to
 *   renew it, which would make AC4's "automatic refresh" impossible, not
 *   a permission this product actually wants.
 *
 * Deliberately NOT requested: `ActivityFeed.Start`/`ActivityFeed.Stop`
 * (manage subscriptions — a write action), and no Graph mail/file/directory
 * scopes beyond this — nothing here can read a mailbox's contents or a
 * file's contents, only the audit trail of activity.
 */
export const M365_SCOPES = [
  'https://manage.office.com/ActivityFeed.Read',
  'https://manage.office.com/ActivityFeed.ReadDlp',
  'offline_access',
] as const;

export class OAuthError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined,
    public readonly description: string | undefined,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

/**
 * True for the error Microsoft's token endpoint returns when a refresh
 * token can no longer be used — the admin revoked consent, the app
 * registration's permissions changed, or the token was explicitly
 * invalidated. `invalid_grant` is the one error code that specifically
 * means this (as opposed to e.g. `invalid_client`, a configuration
 * problem on THIS app's side) — this is AC4's "clear surfacing when
 * consent is revoked" half; the Scheduler-level mapping to
 * `ErrConsentRevoked`/`status='revoked'` (P1-01/P1-11) is what a future
 * M365 Connector's Fetch/HealthCheck calls when IT sees this.
 */
export function isConsentRevokedError(err: unknown): boolean {
  return err instanceof OAuthError && err.code === 'invalid_grant';
}

function tokenEndpoint(config: M365OAuthConfig): string {
  return `${config.authorityBaseUrl ?? DEFAULT_AUTHORITY}/common/oauth2/v2.0/token`;
}

/**
 * Builds the URL an admin is redirected to. PKCE (RFC 7636) even though
 * this is a confidential client with a client_secret — defence in depth
 * against the authorization code being intercepted in the redirect itself
 * (a browser history entry, a referrer leak, a proxy log), which a
 * client_secret alone does nothing to prevent since the SECRET never
 * appears in that URL at all.
 *
 * `prompt=admin_consent`: this is the admin-consent flow specifically
 * (AC's own ticket title) — a tenant admin consenting on behalf of their
 * whole organisation, not an individual user consenting for themselves.
 */
export function buildAuthorizeUrl(config: M365OAuthConfig, state: string, codeVerifier: string): string {
  const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const url = new URL(`${config.authorityBaseUrl ?? DEFAULT_AUTHORITY}/common/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', M365_SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'admin_consent');
  return url.toString();
}

export interface TokenResult {
  accessToken: string;
  refreshToken: string;
  /** Unix seconds — Microsoft's own `expires_in` is relative; this is
   * resolved to an absolute instant at the moment of exchange/refresh, so
   * nothing downstream has to remember "and when did we ask." */
  expiresAt: number;
  scope: string;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postTokenRequest(config: M365OAuthConfig, body: URLSearchParams): Promise<TokenResult> {
  const now = Math.floor(Date.now() / 1000);
  const res = await fetch(tokenEndpoint(config), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  let parsed: RawTokenResponse;
  try {
    parsed = (await res.json()) as RawTokenResponse;
  } catch {
    throw new OAuthError(`token endpoint returned a non-JSON response (HTTP ${res.status})`, undefined, undefined);
  }

  if (!res.ok || parsed.error) {
    throw new OAuthError(
      `token request failed: ${parsed.error ?? res.status}`,
      parsed.error,
      parsed.error_description,
    );
  }
  if (!parsed.access_token || !parsed.refresh_token || !parsed.expires_in) {
    throw new OAuthError('token response is missing required fields', undefined, undefined);
  }

  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: now + parsed.expires_in,
    scope: parsed.scope ?? M365_SCOPES.join(' '),
  };
}

/** Exchanges an authorization code (from the callback) for an access +
 * refresh token pair. */
export async function exchangeCodeForTokens(config: M365OAuthConfig, code: string, codeVerifier: string): Promise<TokenResult> {
  return postTokenRequest(
    config,
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      code_verifier: codeVerifier,
    }),
  );
}

/** AC3 — "Token refresh is automatic." This is the mechanism; the
 * "automatic" half is whoever calls this on a schedule noticing the
 * stored access token is expired (or about to be) and calling this
 * before the next API call, which is P1-03's connector's job once it
 * exists, not this file's. */
export async function refreshAccessToken(config: M365OAuthConfig, refreshToken: string): Promise<TokenResult> {
  return postTokenRequest(
    config,
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  );
}
