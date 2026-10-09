/**
 * P7-01 (OAuth-client half) — against a local mock that speaks Google's
 * own documented token-endpoint contract, not a real Workspace tenant
 * (see mock-google-token-endpoint.ts's own doc comment for why).
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  isConsentRevokedError,
  OAuthError,
  GOOGLE_SCOPES,
  type GoogleOAuthConfig,
} from '../connectors/google-oauth.js';
import { startMockGoogleTokenEndpoint, REVOKED_REFRESH_TOKEN, type MockGoogleTokenEndpoint } from './mock-google-token-endpoint.js';

let mock: MockGoogleTokenEndpoint;
let config: GoogleOAuthConfig;

beforeEach(async () => {
  mock = await startMockGoogleTokenEndpoint();
  config = {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'https://sentinel.example.invalid/connectors/google/callback',
    tokenEndpointBaseUrl: mock.tokenEndpointBaseUrl,
  };
});

afterEach(() => mock.close());

describe('buildAuthorizeUrl', () => {
  it('requests only the documented read-only scope, with offline access for a refresh token', () => {
    const url = new URL(buildAuthorizeUrl(config, 'state-123', 'verifier-abc'));
    const scope = url.searchParams.get('scope');
    expect(scope).toBe(GOOGLE_SCOPES.join(' '));
    expect(scope).toContain('readonly');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
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
    expect(result.scope).toContain('admin.reports.audit.readonly');
    expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(mock.exchangedCodes).toContain('auth-code-xyz');
  });
});

describe('refreshAccessToken', () => {
  it('exchanges a valid refresh token for a fresh access token, keeping the SAME refresh token (Google never rotates it)', async () => {
    const result = await refreshAccessToken(config, 'a-valid-refresh-token');

    expect(result.accessToken).toMatch(/^mock-refreshed-access-token-/);
    expect(result.refreshToken).toBe('a-valid-refresh-token');
    expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('a revoked refresh token surfaces as a recognisable, specific error — not a generic failure', async () => {
    const err = await refreshAccessToken(config, REVOKED_REFRESH_TOKEN).catch((e) => e);

    expect(err).toBeInstanceOf(OAuthError);
    expect(isConsentRevokedError(err)).toBe(true);
  });

  it('isConsentRevokedError is false for an unrelated error', () => {
    expect(isConsentRevokedError(new OAuthError('boom', 'invalid_client', undefined))).toBe(false);
    expect(isConsentRevokedError(new Error('not even an OAuthError'))).toBe(false);
  });
});
