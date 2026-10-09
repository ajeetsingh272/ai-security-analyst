/**
 * A local stand-in for Google's OAuth 2.0 token endpoint — returns exactly
 * the response shapes https://developers.google.com/identity/protocols/oauth2/web-server
 * documents for `authorization_code` and `refresh_token` grants, including
 * the `invalid_grant` error shape for a revoked/invalid refresh token.
 * Mirrors mock-m365-token-endpoint.ts's own doc comment and framing: a
 * real HTTP server that speaks the real documented contract, so
 * google-oauth.ts's request construction and response parsing are
 * genuinely exercised end to end; only Google's own real servers and a
 * real Workspace test tenant are what's missing (this ticket's own
 * disclosed T1 gap).
 */
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';

/** A refresh token value that deterministically triggers the
 * `invalid_grant`/revoked-consent response. */
export const REVOKED_REFRESH_TOKEN = 'revoked-refresh-token';

export interface MockGoogleTokenEndpoint {
  tokenEndpointBaseUrl: string;
  close: () => Promise<void>;
  /** Every authorization code this mock has ever issued a token for. */
  exchangedCodes: string[];
}

export async function startMockGoogleTokenEndpoint(): Promise<MockGoogleTokenEndpoint> {
  const exchangedCodes: string[] = [];

  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/token')) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const grantType = params.get('grant_type');

      if (grantType === 'authorization_code') {
        const code = params.get('code') ?? '';
        exchangedCodes.push(code);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            access_token: `mock-access-token-for-${code}`,
            refresh_token: `mock-refresh-token-for-${code}`,
            expires_in: 3600,
            scope: 'https://www.googleapis.com/auth/admin.reports.audit.readonly',
          }),
        );
        return;
      }

      if (grantType === 'refresh_token') {
        const refreshToken = params.get('refresh_token');
        if (refreshToken === REVOKED_REFRESH_TOKEN) {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({
              error: 'invalid_grant',
              error_description: 'Token has been expired or revoked.',
            }),
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            access_token: `mock-refreshed-access-token-${randomBytes(4).toString('hex')}`,
            // Google never returns a new refresh_token on an ordinary
            // refresh call — deliberately omitted here, matching the real
            // documented contract, unlike M365's mock which echoes one.
            expires_in: 3600,
            scope: 'https://www.googleapis.com/auth/admin.reports.audit.readonly',
          }),
        );
        return;
      }

      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unsupported_grant_type' }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server did not bind to a port');

  return {
    tokenEndpointBaseUrl: `http://127.0.0.1:${address.port}`,
    exchangedCodes,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
