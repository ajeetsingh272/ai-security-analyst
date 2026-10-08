import type { GraphClient, GraphResponse } from '../types.js';

/** An in-memory stand-in for Microsoft Graph — not a mocked `fetch`,
 * because what these tests need to control is RESOURCE STATE (does
 * this user exist, is it already disabled) across multiple calls
 * within one test, which a one-shot fetch mock expresses awkwardly.
 * Call log is exposed so a test can assert exactly what WAS and
 * was NOT called (the idempotency tests' whole point). */
export class FakeGraphClient implements GraphClient {
  calls: Array<{ method: string; path: string; body?: unknown }> = [];
  users = new Map<string, { userPrincipalName: string; accountEnabled: boolean; passwordProfile?: { forceChangePasswordNextSignIn: boolean } }>();
  rules = new Map<string, { displayName: string }>();
  /** When set, every call (including the premise-check GET) fails
   * with this status — simulates a total Graph outage. */
  failAllWith?: number;
  /** When set, only mutating calls (PATCH/POST/DELETE) fail — the
   * premise check still reads real state successfully, so this is
   * what actually isolates "execution itself failed partway" (T4) from
   * "we couldn't even validate the premise" (a different, earlier
   * failure point). */
  failMutationsWith?: number;

  async get(path: string): Promise<GraphResponse> {
    this.calls.push({ method: 'GET', path });
    if (this.failAllWith) return { status: this.failAllWith, body: null };

    const userMatch = /^\/users\/([^/?]+)/.exec(path);
    if (userMatch && path.includes('/mailFolders/')) {
      const ruleMatch = /messageRules\/([^/?]+)/.exec(path);
      const rule = ruleMatch ? this.rules.get(ruleMatch[1]!) : undefined;
      if (!rule) return { status: 404, body: null };
      return { status: 200, body: rule };
    }
    if (userMatch) {
      const user = this.users.get(userMatch[1]!);
      if (!user) return { status: 404, body: null };
      return { status: 200, body: user };
    }
    return { status: 404, body: null };
  }

  async patch(path: string, body: unknown): Promise<GraphResponse> {
    this.calls.push({ method: 'PATCH', path, body });
    if (this.failAllWith) return { status: this.failAllWith, body: null };
    if (this.failMutationsWith) return { status: this.failMutationsWith, body: null };
    const userMatch = /^\/users\/([^/?]+)/.exec(path);
    if (!userMatch) return { status: 404, body: null };
    const user = this.users.get(userMatch[1]!);
    if (!user) return { status: 404, body: null };
    Object.assign(user, body);
    return { status: 204, body: null };
  }

  async post(path: string): Promise<GraphResponse> {
    this.calls.push({ method: 'POST', path });
    if (this.failAllWith) return { status: this.failAllWith, body: null };
    if (this.failMutationsWith) return { status: this.failMutationsWith, body: null };
    return { status: 200, body: null };
  }

  async delete(path: string): Promise<GraphResponse> {
    this.calls.push({ method: 'DELETE', path });
    if (this.failAllWith) return { status: this.failAllWith, body: null };
    if (this.failMutationsWith) return { status: this.failMutationsWith, body: null };
    const ruleMatch = /messageRules\/([^/?]+)/.exec(path);
    if (ruleMatch) {
      const existed = this.rules.delete(ruleMatch[1]!);
      return { status: existed ? 204 : 404, body: null };
    }
    return { status: 404, body: null };
  }
}
