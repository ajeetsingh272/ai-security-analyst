/**
 * P7-06: a liveness/readiness target for the dashboard's own
 * Kubernetes probes (infra/k8s/dashboard.yaml) — this app talks to
 * apps/api as its backend and has no database/queue connection of its
 * own to check, so "the Next.js server process can handle a request
 * at all" is the whole, honest extent of what this endpoint verifies.
 */
export async function GET(): Promise<Response> {
  return Response.json({ ok: true });
}
