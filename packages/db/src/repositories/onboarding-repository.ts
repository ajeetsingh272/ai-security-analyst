/**
 * P6-12: the pilot onboarding funnel — reads the funnel's own events
 * straight from `audit_log` (the same "durable, queryable 'this
 * happened' ledger" every other funnel in this repo uses — P6-05's
 * scan funnel, P6-07's report funnel — rather than a Prometheus/OTel
 * counter, since no otel-collector can run in this sandbox).
 *
 * There is no dedicated "signup" audit event anywhere in this product
 * — tenants are always created out-of-band (direct SQL, by whoever
 * provisions a new pilot customer), never through a product signup
 * flow. `tenants.created_at` is therefore the only honest t0 for this
 * funnel; this file does not invent a fictitious `auth.sign_up` event
 * to paper over that gap.
 */
import type { Pool } from 'pg';

export interface OnboardingFunnelSummary {
  tenantId: string;
  name: string;
  signupAt: string;
  connectorConnectStartedAt: string | null;
  connectorConnectedAt: string | null;
  firstCaseAt: string | null;
  /** Seconds from signup to the first connected connector — null until
   * one is actually connected. */
  timeToFirstConnectorSeconds: number | null;
  /** Seconds from signup to the first case this tenant ever had —
   * null until one exists. */
  timeToFirstCaseSeconds: number | null;
  /** Started the M365 OAuth flow at least once but has never
   * completed it — AC "drop-off points in onboarding are
   * instrumented"'s own concrete signal. */
  droppedOffAtConnector: boolean;
  feedbackCount: number;
  falsePositiveCount: number;
  openTuningBacklogCount: number;
}

function secondsBetween(fromIso: string, toIso: string | null): number | null {
  if (toIso === null) return null;
  return Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 1000);
}

/**
 * Deliberately a plain `pool.query`, not a `TenantScopedRepository`
 * method — mirroring the SAME established cross-tenant platform-wide
 * read pattern as `listTenantUsageSummaries` (P6-10): a pilot-progress
 * view inherently spans every tenant, and goes through the pool's own
 * default connection rather than any single tenant's RLS-scoped
 * context.
 */
export async function listOnboardingFunnelSummaries(pool: Pool): Promise<OnboardingFunnelSummary[]> {
  const { rows } = await pool.query<{
    tenant_id: string;
    name: string;
    signup_at: string;
    connect_started_at: string | null;
    connector_connected_at: string | null;
    first_case_at: string | null;
    feedback_count: string;
    false_positive_count: string;
    open_tuning_backlog_count: string;
  }>(`
    SELECT
      t.id AS tenant_id, t.name, t.created_at AS signup_at,
      started.occurred_at AS connect_started_at,
      connected.occurred_at AS connector_connected_at,
      first_case.created_at AS first_case_at,
      COALESCE(fb.feedback_count, 0) AS feedback_count,
      COALESCE(fb.false_positive_count, 0) AS false_positive_count,
      COALESCE(tb.open_count, 0) AS open_tuning_backlog_count
    FROM tenants t
    LEFT JOIN LATERAL (
      SELECT occurred_at FROM audit_log
       WHERE tenant_id = t.id AND action = 'onboarding.connector_connect_started'
       ORDER BY occurred_at ASC LIMIT 1
    ) started ON true
    LEFT JOIN LATERAL (
      SELECT occurred_at FROM audit_log
       WHERE tenant_id = t.id AND action = 'connector.consent_granted'
       ORDER BY occurred_at ASC LIMIT 1
    ) connected ON true
    LEFT JOIN LATERAL (
      SELECT MIN(created_at) AS created_at FROM cases WHERE tenant_id = t.id
    ) first_case ON true
    LEFT JOIN (
      SELECT tenant_id, count(*) AS feedback_count, count(*) FILTER (WHERE is_false_positive) AS false_positive_count
        FROM feedback GROUP BY tenant_id
    ) fb ON fb.tenant_id = t.id
    LEFT JOIN (
      SELECT tenant_id, count(*) AS open_count FROM tuning_backlog_items WHERE status = 'open' GROUP BY tenant_id
    ) tb ON tb.tenant_id = t.id
    ORDER BY t.name
  `);

  return rows.map((row) => {
    const signupAt = new Date(row.signup_at).toISOString();
    const connectStartedAt = row.connect_started_at ? new Date(row.connect_started_at).toISOString() : null;
    const connectorConnectedAt = row.connector_connected_at ? new Date(row.connector_connected_at).toISOString() : null;
    const firstCaseAt = row.first_case_at ? new Date(row.first_case_at).toISOString() : null;

    return {
      tenantId: row.tenant_id,
      name: row.name,
      signupAt,
      connectorConnectStartedAt: connectStartedAt,
      connectorConnectedAt,
      firstCaseAt,
      timeToFirstConnectorSeconds: secondsBetween(signupAt, connectorConnectedAt),
      timeToFirstCaseSeconds: secondsBetween(signupAt, firstCaseAt),
      droppedOffAtConnector: connectStartedAt !== null && connectorConnectedAt === null,
      feedbackCount: Number(row.feedback_count),
      falsePositiveCount: Number(row.false_positive_count),
      openTuningBacklogCount: Number(row.open_tuning_backlog_count),
    };
  });
}
