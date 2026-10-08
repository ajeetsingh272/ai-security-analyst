/**
 * The real `GraphClient` — a thin `fetch` wrapper over Microsoft
 * Graph's REST API. Takes an already-valid bearer token; acquiring and
 * refreshing one for a given tenant is composed from the EXISTING
 * M365 OAuth building blocks (apps/api/src/connectors/m365-oauth.ts's
 * own `refreshAccessToken`, already unit-tested) at the apps/api layer
 * that wires this package into the approvals route — kept out of this
 * package the same way @sentinel/notifications keeps Postgres out of
 * its dispatcher.
 *
 * No real Entra app registration or M365 test tenant exists in this
 * environment (the same gap m365-connector.ts's own doc comment
 * already discloses), so this class has never made a real Graph call —
 * every playbook's own test exercises it against a fake `GraphClient`
 * instead. The HTTP shape itself (base URL, bearer header, JSON
 * body/response) is Microsoft's own documented Graph v1.0 contract.
 */
import type { GraphClient, GraphResponse } from './types.js';

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

export class FetchGraphClient implements GraphClient {
  constructor(private readonly accessToken: string) {}

  private async request(method: string, path: string, body?: unknown): Promise<GraphResponse> {
    const response = await fetch(`${GRAPH_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    // 204 No Content (Graph's own response to most PATCH/POST/DELETE
    // calls here) has no JSON body to parse.
    const responseBody = response.status === 204 ? null : await response.json().catch(() => null);
    return { status: response.status, body: responseBody };
  }

  get(path: string): Promise<GraphResponse> {
    return this.request('GET', path);
  }
  patch(path: string, body: unknown): Promise<GraphResponse> {
    return this.request('PATCH', path, body);
  }
  post(path: string, body?: unknown): Promise<GraphResponse> {
    return this.request('POST', path, body);
  }
  delete(path: string): Promise<GraphResponse> {
    return this.request('DELETE', path);
  }
}
