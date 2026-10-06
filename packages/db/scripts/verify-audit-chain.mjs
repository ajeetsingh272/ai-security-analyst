#!/usr/bin/env node
/**
 * The audit log chain verifier's CLI entry point (P0-06 AC4, AC5).
 *
 * Walks every tenant's chain and reports the first break per tenant, using
 * the pure logic in chain-verifier.mjs. This file's only job is to be the
 * thin, Postgres-aware wrapper: fetch rows, hand them to verifyChain, format
 * the result. The verification logic itself is tested without a database at
 * all (src/__tests__/audit-chain.test.ts) — if this script reports a false
 * positive or misses a real break, the bug is almost certainly here, in the
 * fetching, not in the algorithm.
 *
 *   node scripts/verify-audit-chain.mjs
 *   node scripts/verify-audit-chain.mjs --tenant <uuid>   one tenant only
 *
 * Exit code is the alert: 0 means every tenant's chain verified clean, 1
 * means at least one did not. "Runs as a scheduled job and alerts on
 * failure" (AC5) means, concretely in this phase: a GitHub Actions workflow
 * on a cron schedule invokes this, and a non-zero exit fails that run, which
 * is what GitHub's own notification surfaces as a failed scheduled workflow.
 * That is a real, working alert — not a placeholder — and it is honestly
 * scoped: it is GitHub's failure notification, not a dedicated paging
 * integration, because no such integration exists yet in this phase.
 */
import pg from 'pg';
import { verifyChain } from './chain-verifier.mjs';

const POSTGRES_URL =
  process.env.POSTGRES_URL ?? 'postgres://sentinel:sentinel@localhost:5434/sentinel';

const args = process.argv.slice(2);
const tenantFlagIndex = args.indexOf('--tenant');
const onlyTenant = tenantFlagIndex !== -1 ? args[tenantFlagIndex + 1] : null;

const client = new pg.Client({ connectionString: POSTGRES_URL });
try {
  await client.connect();
} catch (err) {
  console.error(
    `verify-audit-chain: cannot reach Postgres at ${POSTGRES_URL.replace(/:[^:@]*@/, ':***@')}\n` +
      `                    ${err.message}`,
  );
  process.exit(1);
}

try {
  // sentinel_jobs: BYPASSRLS, so this one query can see every tenant's rows
  // at once rather than iterating with a role switch per tenant — the
  // documented exception in 0001_foundation.sql for background jobs that
  // legitimately span tenants. Read-only here; it never needs more than
  // SELECT, which is all sentinel_jobs is granted.
  await client.query('SET ROLE sentinel_jobs');

  const tenantRows = onlyTenant
    ? [{ tenant_id: onlyTenant }]
    : (
        await client.query(
          'SELECT DISTINCT tenant_id FROM audit_log ORDER BY tenant_id',
        )
      ).rows;

  if (tenantRows.length === 0) {
    console.log('verify-audit-chain: no audit log entries exist yet. Nothing to verify.');
    process.exit(0);
  }

  let brokenCount = 0;
  const results = [];

  for (const { tenant_id } of tenantRows) {
    const { rows } = await client.query(
      `SELECT id, tenant_id, occurred_at, actor_type, actor_id, action,
              subject_type, subject_id, payload, prev_hash, entry_hash
         FROM audit_log
        WHERE tenant_id = $1
        ORDER BY id`,
      [tenant_id],
    );

    const entries = rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      occurredAt: new Date(r.occurred_at).toISOString(),
      actorType: r.actor_type,
      actorId: r.actor_id,
      action: r.action,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      payload: r.payload,
      prevHash: r.prev_hash,
      entryHash: r.entry_hash,
    }));

    const result = verifyChain(entries);
    results.push({ tenantId: tenant_id, entryCount: entries.length, result });
    if (!result.ok) brokenCount++;
  }

  console.log(`verify-audit-chain: checked ${results.length} tenant(s)`);
  for (const r of results) {
    if (r.result.ok) {
      console.log(`  OK      ${r.tenantId}  (${r.entryCount} entries)`);
    } else {
      console.error(
        `  BROKEN  ${r.tenantId}  (${r.entryCount} entries)\n` +
          `          first break at entry id ${r.result.brokenAtId}: ${r.result.reason}`,
      );
    }
  }

  if (brokenCount > 0) {
    console.error(
      `\nALERT: ${brokenCount} of ${results.length} tenant audit chain(s) failed verification.`,
    );
    process.exit(1);
  }

  console.log(`\nAll ${results.length} tenant audit chain(s) verified clean.`);
} finally {
  await client.end();
}
