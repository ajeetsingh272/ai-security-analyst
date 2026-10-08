/**
 * A local stand-in for Slack's own API — answers `oauth.v2.access`
 * (https://api.slack.com/methods/oauth.v2.access) and `chat.postMessage`
 * (https://api.slack.com/methods/chat.postMessage) with exactly the
 * response shapes Slack's own docs specify. Not a mock of "some HTTP
 * server" — a real HTTP server speaking the real documented contract,
 * so slack-oauth.ts's and the Slack channel's request construction and
 * response parsing are genuinely exercised end to end; only the fact
 * that it's Slack's real servers issuing a real bot token for a real
 * workspace is what's missing (the same disclosed gap
 * mock-m365-token-endpoint.ts already has for Microsoft).
 */
import { createServer, type Server } from 'node:http';

export interface MockSlackServer {
  baseUrl: string;
  close: () => Promise<void>;
  exchangedCodes: string[];
  postedMessages: Array<{ channel: string; blocks: unknown }>;
  /** Set to make the NEXT chat.postMessage call fail with this Slack
   * error code — T1's own "channel not found" style failure. */
  nextPostMessageError: string | undefined;
}

export async function startMockSlackServer(): Promise<MockSlackServer> {
  const exchangedCodes: string[] = [];
  const postedMessages: Array<{ channel: string; blocks: unknown }> = [];
  const state: { nextPostMessageError: string | undefined } = { nextPostMessageError: undefined };

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.method === 'POST' && req.url?.endsWith('/api/oauth.v2.access')) {
        const params = new URLSearchParams(body);
        const code = params.get('code') ?? '';
        exchangedCodes.push(code);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            ok: true,
            access_token: `xoxb-mock-${code}`,
            bot_user_id: 'U-MOCK-BOT',
            scope: 'chat:write,channels:read',
            team: { id: 'T-MOCK', name: 'Mock Workspace' },
          }),
        );
        return;
      }

      if (req.method === 'POST' && req.url?.endsWith('/api/chat.postMessage')) {
        if (state.nextPostMessageError) {
          const error = state.nextPostMessageError;
          state.nextPostMessageError = undefined;
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error }));
          return;
        }
        const parsed = JSON.parse(body) as { channel: string; blocks: unknown };
        postedMessages.push(parsed);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server did not bind to a port');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    exchangedCodes,
    postedMessages,
    get nextPostMessageError() {
      return state.nextPostMessageError;
    },
    set nextPostMessageError(value) {
      state.nextPostMessageError = value;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
