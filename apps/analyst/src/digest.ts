/**
 * P4-12: the daily dismissal digest, cross-tenant by construction
 * (mirrors `DegradedQueueRepository`'s own sweep and
 * `services/correlate/cmd/correlate/main.go`'s `runQuietPeriodSweep`:
 * lists tenants via the pool's own default connection, since this is a
 * platform-wide daily job, not one tenant's own request — every actual
 * read still goes through `CasesRepository`, tenant-scoped via
 * `withTenantContext` like everything else this package reads).
 *
 * AC5: "the digest is delivered through the tenant's chosen channel."
 * No real delivery channel exists yet (WhatsApp/Slack/email is P5's
 * own response plane) — honestly scoped the same way every other
 * not-yet-delivered alert in this codebase already is: a real,
 * structured log line per tenant, not a fabricated send.
 */
import type { Pool } from 'pg';
import { withTenantContext, CasesRepository, type DismissalDigestRow } from '@sentinel/db';
import type { Logger } from '@sentinel/observability';

export function renderDigestSummary(rows: readonly DismissalDigestRow[]): string {
  if (rows.length === 0) return 'No dismissals today.';
  return rows
    .map((r) => `${r.actorType === 'ai' ? 'AI' : 'rule'}-dismissed ${r.caseCount} case(s), ${r.signalCount} signal(s) — reason: "${r.reason}"`)
    .join('; ');
}

async function listAllTenantIds(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM tenants');
  return rows.map((r) => r.id);
}

/** Generates and logs one tenant's own digest for `day` — skips a
 * tenant with nothing to report rather than logging an empty digest
 * every day for every quiet tenant. */
export async function generateDailyDigests(pool: Pool, day: Date, logger: Logger): Promise<void> {
  const tenantIds = await listAllTenantIds(pool);
  for (const tenantId of tenantIds) {
    const rows = await withTenantContext(tenantId, () => new CasesRepository(pool).dailyDismissalDigest(day));
    if (rows.length === 0) continue;
    logger.info({ tenant_id: tenantId, digest: rows, summary: renderDigestSummary(rows) }, 'daily dismissal digest generated');
  }
}
