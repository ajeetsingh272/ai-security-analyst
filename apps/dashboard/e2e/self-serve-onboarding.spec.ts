/**
 * P6-13 — the P6 exit criterion as an automated test: signup to
 * connector to scan to first case to weekly report, unassisted.
 *
 * ⚠ HONEST, UNRESOLVABLE GAP — read before trusting this test as the
 * literal AC: **"runs against a real Microsoft test tenant, not a
 * mock."** There is no real Entra app registration, real Microsoft
 * test-tenant credentials, or network path to login.microsoftonline.com
 * anywhere in this sandbox — the same gap every other M365-related
 * test in this repo already discloses (m365-connector.integration.
 * test.ts, connectors.spec.ts, onboarding-funnel.integration.test.ts).
 * This is not a "close enough" substitute; it is a flat inability this
 * environment cannot engineer around, and it is disclosed here
 * prominently rather than quietly worked around. Whoever reviews this
 * PR should treat "runs against a real Microsoft tenant" as NOT met by
 * this test, and decide separately whether/when to run the real thing
 * against an actual Entra registration before this feature is trusted
 * for real pilot customers.
 *
 * What IS real here, against the real dashboard dev server, the real
 * API server, and the real Postgres/Redis the dev stack provides:
 * sign-in, the connectors page rendering a connected state, triggering
 * a REAL P6-05 scan, and triggering a REAL P6-07 weekly report
 * generation — every HTTP request these steps make is real, nothing is
 * stubbed at the browser layer. Two things are seeded directly rather
 * than produced by the system end-to-end, each for its own disclosed
 * reason:
 *   - the CONNECTOR's own "connected" state — mirrors connectors.
 *     spec.ts's own established precedent (seedConnector), since
 *     actually driving Microsoft's OAuth consent screen needs the same
 *     real Entra app registration this whole file is about;
 *   - the tenant's FIRST CASE — real signal ingestion needs the
 *     ClickHouse-backed pipeline, which cannot run in this sandbox
 *     (blocked S3/MinIO dependency, the same gap every ClickHouse-
 *     touching P6 ticket this phase already hit) — seeding one
 *     directly stands in for "detection already happened," giving the
 *     scan and the weekly report something real to summarise.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { test, expect, type Page } from '@playwright/test';
import { seedTenantAndUser, seedCase, seedConnector, cleanupUser, TEST_PASSWORD, type SeededUser } from './fixtures.ts';

async function signInAs(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/cases');
}

/** T3's own mechanism: every step of the journey is named, and a
 * failure inside one is rethrown with that name attached — "Step 'run
 * the free scan' failed: ..." rather than a bare stack trace pointing
 * at a generic helper, so a real nightly failure tells a human which
 * part of the self-serve path broke without them reading the test
 * source first. */
async function runStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Step "${name}" failed: ${message}`);
  }
}

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

test.describe('T1/T2: the full self-serve path completes within 15 minutes, ending in a real weekly report', () => {
  let user: SeededUser;

  test.beforeAll(async () => {
    // "Signup" itself has no product event to drive (P6-12's own
    // disclosure: tenants are always created out-of-band in this
    // product, never through a self-serve signup flow) — this journey
    // starts from the moment a provisioned admin first signs in,
    // which is the earliest REAL step this product offers today.
    user = await seedTenantAndUser('admin');
  });

  test.afterAll(async () => {
    await cleanupUser(user);
  });

  test('signup (provisioning) -> connector -> scan -> first case -> weekly report, under 15 minutes', async ({ page }) => {
    const startedAt = Date.now();

    await runStep('sign in as the newly provisioned admin', () => signInAs(page, user.email));

    await runStep('connector shows as connected', async () => {
      // Seeded, not driven through a real OAuth consent screen — see
      // this file's own top-of-file disclosure for why.
      await seedConnector(user.tenantId, 'healthy');
      await page.goto('/connectors');
      await expect(page.getByText('Connected')).toBeVisible();
    });

    await runStep('first case exists for this tenant', async () => {
      // Seeded, not produced by real signal ingestion — see this
      // file's own top-of-file disclosure for why.
      await seedCase(user.tenantId, 'high', 'Self-serve onboarding probe case');
    });

    await runStep('run the free scan and see a real, non-empty report', async () => {
      await page.goto('/connectors');
      await page.getByRole('button', { name: 'Run a free scan' }).click();
      await page.waitForURL('**/connectors/scan/*');
      await expect(page.getByText('Self-serve onboarding probe case')).toBeVisible({ timeout: 15_000 });
    });

    await runStep('generate a real weekly report and see it on the dashboard', async () => {
      await page.goto('/reports');
      await page.getByRole('button', { name: 'Generate now' }).click();
      await expect(page.getByText(/Sentinel caught 1 thing|Nothing serious this week|Nothing happened this week/)).toBeVisible({ timeout: 15_000 });
    });

    const elapsedMs = Date.now() - startedAt;
    // T1's own literal bound. Trivially satisfied in this sandbox
    // (no real external wait exists here to make it otherwise) — the
    // REAL production bottleneck this bound is meant to catch
    // (Microsoft's own activity-feed propagation delay before any
    // detection can happen at all) is not reproducible without the
    // real Microsoft tenant this file's own top comment already
    // discloses as unavailable.
    expect(elapsedMs).toBeLessThan(FIFTEEN_MINUTES_MS);
  });
});

test.describe('T3: failure reporting correctly identifies a deliberately broken step', () => {
  let user: SeededUser;

  test.beforeAll(async () => {
    user = await seedTenantAndUser('admin');
  });

  test.afterAll(async () => {
    await cleanupUser(user);
  });

  test('a deliberately broken scan step is reported by name, not as a bare, unattributed failure', async ({ page }) => {
    await signInAs(page, user.email);
    await seedConnector(user.tenantId, 'healthy');

    // Deliberately breaks ONLY the scan step: a scan id that was never
    // created can never resolve, the same way a real regression in the
    // scan trigger itself would leave the report unreachable. Asserts
    // the IDENTICAL happy-path expectation the real step above checks
    // (a finding's text becoming visible) — against a bogus id, that
    // assertion genuinely times out and throws, which is exactly what
    // this test is proving `runStep` reports correctly.
    let caught: Error | undefined;
    try {
      await runStep('run the free scan and see a real, non-empty report', async () => {
        await page.goto('/connectors/scan/00000000-0000-0000-0000-000000000000');
        await expect(page.getByText('Self-serve onboarding probe case')).toBeVisible({ timeout: 3_000 });
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/^Step "run the free scan and see a real, non-empty report" failed:/);
  });
});
