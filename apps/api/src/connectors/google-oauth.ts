/**
 * The Google Workspace admin-consent OAuth2 client (P7-01) — authorize URL,
 * authorization-code exchange, and refresh-token exchange, against the
 * real Google OAuth 2.0 endpoints
 * (https://developers.google.com/identity/protocols/oauth2/web-server).
 * The second identity-platform OAuth client in this codebase, mirroring
 * m365-oauth.ts's own structure exactly — same disclosed gap: this repo
 * has no real Google Cloud OAuth client registered (client id/secret),
 * so T1 ("consent flow and collection succeed against a Google test
 * tenant") is proven against a LOCAL mock speaking Google's own documented
 * contract (mock-google-token-endpoint.ts), not real Google servers.
 * Swapping to the real endpoint is a config change, not a rewrite.
 */
import { createHash } from 'node:crypto';

const DEFAULT_AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const DEFAULT_TOKEN_ENDPOINT_BASE = 'https://oauth2.googleapis.com';

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizeBaseUrl?: string | undefined;
  tokenEndpointBaseUrl?: string | undefined;
}

/**
 * AC1: "Admin SDK Reports API consent flow with read-only scopes." This IS
 * that documentation.
 *
 * `admin.reports.audit.readonly` is the ONLY scope requested — read-only
 * access to the Admin SDK Reports API's activity feed (login, admin,
 * drive, token, gmail — AC2). Granting it requires the consenting user be
 * a super admin or a delegated admin with the Reports API privilege;
 * nothing about the OAuth request itself grants elevated access beyond
 * what that scope covers. Deliberately NOT requested: any Directory API,
 * Drive API, or Gmail API scope that would let this app read mailbox or
 * file CONTENTS — only the audit trail of activity, same boundary
 * m365-oauth.ts's own M365_SCOPES draws.
 */
export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/admin.reports.audit.readonly'] as const;

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
 * True for the error Google's token endpoint returns when a refresh token
 * can no longer be used — the admin revoked the app's access (via the
 * Google Account's "Third-party apps with account access" page), the
 * token was unused for 6 months, or the user exceeded the per-account
 * refresh-token limit and an older one was invalidated. `invalid_grant` is
 * Google's one error code that specifically means this.
 */
export function isConsentRevokedError(err: unknown): boolean {
  return err instanceof OAuthError && err.code === 'invalid_grant';
}

function tokenEndpoint(config: GoogleOAuthConfig): string {
  return `${config.tokenEndpointBaseUrl ?? DEFAULT_TOKEN_ENDPOINT_BASE}/token`;
}

/**
 * Builds the URL an admin is redirected to. PKCE (RFC 7636), same
 * defence-in-depth reasoning as m365-oauth.ts's own buildAuthorizeUrl.
 *
 * `access_type=offline` is required to receive a refresh token at all.
 * `prompt=consent` forces Google to re-issue one even if this admin
 * already granted this app access before — without it, a re-consent (e.g.
 * after a revoke-then-reconnect) can silently return NO refresh token,
 * which would make AC's "automatic refresh" impossible for that tenant.
 */
export function buildAuthorizeUrl(config: GoogleOAuthConfig, state: string, codeVerifier: string): string {
  const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const url = new URL(config.authorizeBaseUrl ?? DEFAULT_AUTHORIZE_ENDPOINT);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

export interface TokenResult {
  accessToken: string;
  refreshToken: string;
  /** Unix seconds — same "resolved to an absolute instant at exchange
   * time" reasoning as m365-oauth.ts's own TokenResult. */
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

async function postTokenRequest(config: GoogleOAuthConfig, body: URLSearchParams): Promise<TokenResult> {
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
    throw new OAuthError(`token request failed: ${parsed.error ?? res.status}`, parsed.error, parsed.error_description);
  }
  if (!parsed.access_token || !parsed.expires_in) {
    throw new OAuthError('token response is missing required fields', undefined, undefined);
  }

  return {
    accessToken: parsed.access_token,
    // Google omits refresh_token on an ordinary refresh call (it never
    // rotates it) — only the initial exchange call site passes one in
    // explicitly for that case; this fallback only matters there.
    refreshToken: parsed.refresh_token ?? '',
    expiresAt: now + parsed.expires_in,
    scope: parsed.scope ?? GOOGLE_SCOPES.join(' '),
  };
}

/** Exchanges an authorization code (from the callback) for an access +
 * refresh token pair. */
export async function exchangeCodeForTokens(config: GoogleOAuthConfig, code: string, codeVerifier: string): Promise<TokenResult> {
  const result = await postTokenRequest(
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
  if (!result.refreshToken) {
    throw new OAuthError('token exchange did not return a refresh token (access_type=offline&prompt=consent should prevent this)', undefined, undefined);
  }
  return result;
}

/** AC's "automatic refresh" mechanism — same division of responsibility as
 * m365-oauth.ts's own refreshAccessToken: this is the exchange; noticing
 * an expiry and calling it is go/sentinelconnector/google's own
 * tokenProvider's job. Google never rotates the refresh token on refresh,
 * so the caller keeps using the same one it already has. */
export async function refreshAccessToken(config: GoogleOAuthConfig, refreshToken: string): Promise<TokenResult> {
  const result = await postTokenRequest(
    config,
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  );
  return { ...result, refreshToken };
}
