/**
 * P6-05 T4 (and the frontend half of T1/T2/T3) — against the real
 * dashboard dev server and the real API server, both started by
 * playwright.config.ts's webServer, against the real Postgres/Redis
 * the dev stack provides.
 *
 * T1's literal claim (a real 100-seat M365 tenant scans in under 10
 * minutes) is not exercised here — there is no real M365 tenant or
 * replay trigger in this sandbox (0024_scan_jobs.sql's own doc comment
 * has the full, disclosed scope). What's proven here: the scan's own
 * UI flow (connected -> run a scan -> business-language report) in
 * under 10 minutes of WALL CLOCK for a synthetic case set, and the
 * real, queryable funnel.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { test, expect } from '@playwright/test';
import { seedTenantAndUser, seedCase, seedConnector, cleanupUser, auditActionsFor, TEST_PASSWORD, type SeededUser } from './fixtures.ts';

async function signInAs(page: import('@playwright/test').Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/cases');
}

test.describe('the free scan', () => {
  let admin: SeededUser;

  test.beforeAll(async () => {
    admin = await seedTenantAndUser('admin');
    await seedConnector(admin.tenantId, 'healthy');
    await seedCase(admin.tenantId, 'critical', 'Impossible travel for a finance admin');
    await seedCase(admin.tenantId, 'low', 'Routine sign-in from a known device');
  });

  test.afterAll(async () => {
    await cleanupUser(admin);
  });

  test('T1 (UI half)/T2/T4: connect -> run a scan -> business-language report -> share, with every funnel step recorded', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-write']);
    const startedAt = Date.now();
    await signInAs(page, admin.email);
    await page.goto('/connectors');

    await page.getByRole('button', { name: 'Run a free scan' }).click();
    await page.waitForURL(/\/connectors\/scan\/.+/);

    // T2: the known critical finding is surfaced, in business language
    // (people affected, not a raw technical count), not buried.
    await expect(page.getByText(/need.*attention/)).toBeVisible();
    await expect(page.getByText('Impossible travel for a finance admin')).toBeVisible();

    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(10 * 60 * 1000); // AC1's own 10-minute budget

    const scanId = page.url().split('/connectors/scan/')[1]!;

    await page.getByRole('button', { name: 'Copy link to share internally' }).click();
    await expect(page.getByRole('button', { name: 'Link copied' })).toBeVisible();

    // Deduped: Next's dev server runs React in Strict Mode, which
    // deliberately double-invokes an effect once per mount to catch a
    // missing cleanup — ScanReport's own data fetch legitimately fires
    // twice in dev for that reason alone, producing two consecutive
    // 'scan.viewed' entries. A production build's single effect run
    // would not. The funnel's own real claim — every step fired, in
    // order — holds either way; collapsing consecutive duplicates is
    // what actually asserts that, not an exact count tied to a dev-only
    // artifact.
    function dedupeConsecutive(actions: string[]): string[] {
      return actions.filter((action, i) => action !== actions[i - 1]);
    }
    await expect
      .poll(async () => dedupeConsecutive(await auditActionsFor(admin.tenantId, scanId)))
      .toEqual(['scan.started', 'scan.completed', 'scan.viewed', 'scan.report_shared']);
  });

  test('T3: a clean tenant is told so honestly, with no manufactured urgency', async ({ page }) => {
    const cleanTenant = await seedTenantAndUser('admin');
    await seedConnector(cleanTenant.tenantId, 'healthy');

    await signInAs(page, cleanTenant.email);
    await page.goto('/connectors');
    await page.getByRole('button', { name: 'Run a free scan' }).click();
    await page.waitForURL(/\/connectors\/scan\/.+/);

    await expect(page.getByText('Nothing serious found this week.')).toBeVisible();

    await cleanupUser(cleanTenant);
  });
});
