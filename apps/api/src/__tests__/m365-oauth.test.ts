/**
 * P1-02 T3/T4 (OAuth-client half) — against a local mock that speaks
 * Microsoft's own documented token-endpoint contract, not a real
 * Microsoft tenant (see mock-m365-token-endpoint.ts's own doc comment
 * for why, and what that gap actually is).
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  isConsentRevokedError,
  OAuthError,
  M365_SCOPES,
  type M365OAuthConfig,
} from '../connectors/m365-oauth.js';
import { startMockM365TokenEndpoint, REVOKED_REFRESH_TOKEN, type MockM365TokenEndpoint } from './mock-m365-token-endpoint.js';

let mock: MockM365TokenEndpoint;
let config: M365OAuthConfig;

beforeEach(async () => {
  mock = await startMockM365TokenEndpoint();
  config = {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'https://sentinel.example.invalid/connectors/m365/callback',
    authorityBaseUrl: mock.authorityBaseUrl,
  };
});

afterEach(() => mock.close());

describe('buildAuthorizeUrl', () => {
  it('requests only the documented read-only scopes, plus offline_access for a refresh token', () => {
    const url = new URL(buildAuthorizeUrl(config, 'state-123', 'verifier-abc'));
    const scope = url.searchParams.get('scope');
    expect(scope).toBe(M365_SCOPES.join(' '));
    expect(scope).not.toContain('Write');
    expect(scope).not.toContain('ActivityFeed.Start');
  });

  it('derives the PKCE challenge deterministically from the verifier (S256)', () => {
    const verifier = 'a-fixed-verifier-value';
    const expectedChallenge = createHash('sha256').update(verifier).digest('base64url');

    const url = new URL(buildAuthorizeUrl(config, 'state-123', verifier));

    expect(url.searchParams.get('code_challenge')).toBe(expectedChallenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('client_id')).toBe(config.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
  });
});

describe('exchangeCodeForTokens', () => {
  it('exchanges a real authorization code for an access+refresh token pair', async () => {
    const result = await exchangeCodeForTokens(config, 'auth-code-xyz', 'verifier-abc');

    expect(result.accessToken).toContain('auth-code-xyz');
    expect(result.refreshToken).toContain('auth-code-xyz');
    expect(result.scope).toContain('ActivityFeed.Read');
    expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(mock.exchangedCodes).toContain('auth-code-xyz');
  });
});

describe('refreshAccessToken (P1-02 T3 — the refresh mechanism itself; "automatic" is P1-03\'s own connector noticing an expiry and calling this)', () => {
  it('exchanges a valid refresh token for a fresh access token', async () => {
    const result = await refreshAccessToken(config, 'a-valid-refresh-token');

    expect(result.accessToken).toMatch(/^mock-refreshed-access-token-/);
    expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('T4: a revoked refresh token surfaces as a recognisable, specific error — not a generic failure', async () => {
    const err = await refreshAccessToken(config, REVOKED_REFRESH_TOKEN).catch((e) => e);

    expect(err).toBeInstanceOf(OAuthError);
    expect(isConsentRevokedError(err)).toBe(true);
  });

  it('isConsentRevokedError is false for an unrelated error', () => {
    expect(isConsentRevokedError(new OAuthError('boom', 'invalid_client', undefined))).toBe(false);
    expect(isConsentRevokedError(new Error('not even an OAuthError'))).toBe(false);
  });
});
