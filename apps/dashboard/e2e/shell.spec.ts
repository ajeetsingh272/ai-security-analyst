/**
 * P6-01 T1/T4 — against the real dashboard dev server and the real API
 * server, both started by playwright.config.ts's webServer, against the
 * real Postgres/Redis the dev stack provides.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { test, expect } from '@playwright/test';
import { seedTenantAndUser, cleanupUser, TEST_PASSWORD, type SeededUser } from './fixtures.ts';

async function signInAs(page: import('@playwright/test').Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/cases');
}

test.describe('T1: authenticated navigation across every top-level route', () => {
  let owner: SeededUser;

  test.beforeAll(async () => {
    owner = await seedTenantAndUser('owner');
  });

  test.afterAll(async () => {
    await cleanupUser(owner);
  });

  test('an owner signs in and reaches every top-level route from the nav, including settings', async ({ page }) => {
    await signInAs(page, owner.email);

    await expect(page.getByText('Sentinel', { exact: true })).toBeVisible();

    for (const label of ['Cases', 'Connectors', 'Reports', 'Settings'] as const) {
      await page.getByRole('link', { name: label, exact: true }).click();
      // P6-02 replaced the Cases placeholder with the real case list —
      // its filter bar's own accessible label is this route's stable
      // marker now (getByText would also match "severity" inside the
      // empty-state prose this owner's own case-free tenant shows).
      if (label === 'Cases') await expect(page.getByLabel('Severity')).toBeVisible();
      else if (label === 'Connectors') await expect(page.getByText('coming in P6-04')).toBeVisible();
      else if (label === 'Reports') await expect(page.getByText('coming in P6-07')).toBeVisible();
      else await expect(page.getByText('coming in a later ticket')).toBeVisible();
      // AC4: no horizontal scroll at the AC's own minimum width.
      const hasHorizontalScroll = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(hasHorizontalScroll).toBe(false);
    }
  });
});

test.describe('T4: direct navigation to an unauthorised route is refused server-side', () => {
  let readOnly: SeededUser;

  test.beforeAll(async () => {
    readOnly = await seedTenantAndUser('read_only');
  });

  test.afterAll(async () => {
    await cleanupUser(readOnly);
  });

  test('a read_only user has no Settings nav item, and is refused on direct navigation to it', async ({ page }) => {
    await signInAs(page, readOnly.email);

    await expect(page.getByRole('link', { name: 'Settings', exact: true })).not.toBeVisible();

    // The literal T4 scenario: typing the URL directly, not clicking
    // through a UI that happens not to show the link.
    await page.goto('/settings');
    await expect(page.getByText("You don't have access to this page")).toBeVisible();
    await expect(page.getByText('Tenant settings are coming')).not.toBeVisible();
  });

  test('with no session at all, every authenticated route redirects to sign-in', async ({ browser }) => {
    const context = await browser.newContext(); // no stored cookies
    const page = await context.newPage();

    for (const path of ['/', '/cases', '/connectors', '/reports', '/settings']) {
      await page.goto(path);
      await page.waitForURL('**/sign-in');
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    }

    await context.close();
  });
});
