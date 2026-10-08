/**
 * A local stand-in for Microsoft Graph's own REST API — answers
 * exactly the endpoints `revoke_sessions` and `delete_inbox_rule`
 * (@sentinel/playbooks) actually call, with the real documented
 * response shapes (https://learn.microsoft.com/en-us/graph/api/user-get,
 * .../user-revokesigninsessions, .../message-get-rules,
 * .../messagerule-delete). Not a mock of "some HTTP server" — a real
 * HTTP server speaking Graph's real contract for these specific calls,
 * so P5-10's own end-to-end test genuinely exercises both playbooks'
 * premise-check-then-mutate logic; only the fact that it's Microsoft's
 * real servers against a real tenant is what's missing (the same
 * disclosed gap every other real provider in this repo's own tests
 * already has).
 */
import { createServer, type Server } from 'node:http';

export interface SeededUser {
  userPrincipalName: string;
}

export interface SeededRule {
  displayName: string;
}

export interface MockGraphServer {
  baseUrl: string;
  close: () => Promise<void>;
  revokedSessionsFor: string[];
  deletedRules: Array<{ userId: string; ruleId: string }>;
}

export async function startMockGraphServer(users: Record<string, SeededUser>, rules: Record<string, SeededRule>): Promise<MockGraphServer> {
  const revokedSessionsFor: string[] = [];
  const deletedRules: Array<{ userId: string; ruleId: string }> = [];

  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';

    const ruleMatch = /^\/users\/([^/]+)\/mailFolders\/inbox\/messageRules\/([^/?]+)/.exec(url);
    if (ruleMatch) {
      const [, userId, ruleId] = ruleMatch;
      const rule = rules[ruleId!];
      if (req.method === 'GET') {
        if (!rule) {
          res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 'ItemNotFound' } }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ displayName: rule.displayName }));
        }
        return;
      }
      if (req.method === 'DELETE') {
        deletedRules.push({ userId: userId!, ruleId: ruleId! });
        res.writeHead(204).end();
        return;
      }
    }

    const revokeMatch = /^\/users\/([^/]+)\/revokeSignInSessions/.exec(url);
    if (revokeMatch && req.method === 'POST') {
      revokedSessionsFor.push(revokeMatch[1]!);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ value: true }));
      return;
    }

    const userMatch = /^\/users\/([^/?]+)/.exec(url);
    if (userMatch && req.method === 'GET') {
      const user = users[userMatch[1]!];
      if (!user) {
        res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 'Request_ResourceNotFound' } }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ userPrincipalName: user.userPrincipalName }));
      }
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server did not bind to a port');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    revokedSessionsFor,
    deletedRules,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
