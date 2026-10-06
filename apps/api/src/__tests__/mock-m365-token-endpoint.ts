/**
 * A local stand-in for Microsoft's token endpoint — returns exactly the
 * response shapes https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oauth-code
 * documents for `authorization_code` and `refresh_token` grants,
 * including the `invalid_grant` error shape for a revoked/invalid
 * refresh token. Not a mock of "some HTTP server" — a real HTTP server
 * that speaks the real documented contract, so m365-oauth.ts's request
 * construction and response parsing are genuinely exercised end to end;
 * only the fact that it's Microsoft's real servers issuing real tokens
 * against a real tenant is what's missing (P1-02 T1's own disclosed gap).
 */
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';

/** A refresh token value that deterministically triggers the
 * `invalid_grant`/revoked-consent response — tests ask for this exact
 * string rather than configuring the mock's behaviour out-of-band. */
export const REVOKED_REFRESH_TOKEN = 'revoked-refresh-token';

export interface MockM365TokenEndpoint {
  authorityBaseUrl: string;
  close: () => Promise<void>;
  /** Every authorization code this mock has ever issued an access token
   * for — lets a test assert exchangeCodeForTokens was actually called
   * with the code the callback route received, not a different one. */
  exchangedCodes: string[];
}

export async function startMockM365TokenEndpoint(): Promise<MockM365TokenEndpoint> {
  const exchangedCodes: string[] = [];

  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/common/oauth2/v2.0/token')) {
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
            scope: 'https://manage.office.com/ActivityFeed.Read https://manage.office.com/ActivityFeed.ReadDlp',
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
              error_description: 'AADSTS70008: The refresh token has expired or is invalid because it was revoked.',
            }),
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            access_token: `mock-refreshed-access-token-${randomBytes(4).toString('hex')}`,
            refresh_token: refreshToken, // Microsoft may or may not rotate it; this mock doesn't.
            expires_in: 3600,
            scope: 'https://manage.office.com/ActivityFeed.Read https://manage.office.com/ActivityFeed.ReadDlp',
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
    authorityBaseUrl: `http://127.0.0.1:${address.port}`,
    exchangedCodes,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
