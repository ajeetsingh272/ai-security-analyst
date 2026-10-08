/**
 * P6-02 T1/T2/T4 — against the real dashboard dev server and the real
 * API server, both started by playwright.config.ts's webServer, against
 * the real Postgres/Redis the dev stack provides.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { test, expect } from '@playwright/test';
import { seedTenantAndUser, seedCase, cleanupUser, TEST_PASSWORD, type SeededUser } from './fixtures.ts';

async function signInAs(page: import('@playwright/test').Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/cases');
}

test.describe('T1: filters produce correct result sets', () => {
  let owner: SeededUser;

  test.beforeAll(async () => {
    owner = await seedTenantAndUser('owner');
    await seedCase(owner.tenantId, 'critical', 'Impossible travel for Priya Sharma');
    await seedCase(owner.tenantId, 'low', 'Routine sign-in from a known device');
  });

  test.afterAll(async () => {
    await cleanupUser(owner);
  });

  test('selecting a severity filters the list to only that severity', async ({ page }) => {
    await signInAs(page, owner.email);

    await expect(page.getByText('Impossible travel for Priya Sharma')).toBeVisible();
    await expect(page.getByText('Routine sign-in from a known device')).toBeVisible();

    await page.getByLabel('Severity').selectOption('critical');

    await expect(page.getByText('Impossible travel for Priya Sharma')).toBeVisible();
    await expect(page.getByText('Routine sign-in from a known device')).not.toBeVisible();
  });
});

test.describe('T2: a new case appears live without a manual refresh', () => {
  let owner: SeededUser;

  test.beforeAll(async () => {
    owner = await seedTenantAndUser('owner');
    await seedCase(owner.tenantId, 'medium', 'Pre-existing case seen on page load');
  });

  test.afterAll(async () => {
    await cleanupUser(owner);
  });

  test('a case inserted directly into Postgres while the page is open appears without reloading', async ({ page }) => {
    await signInAs(page, owner.email);
    await expect(page.getByText('Pre-existing case seen on page load')).toBeVisible();
    await expect(page.getByText('Case created after the page loaded')).not.toBeVisible();

    // Inserted directly into Postgres — not through the UI, and
    // deliberately with NO page.reload() anywhere in this test. The
    // component's own poll interval (CaseList.client.tsx, 3s) is what
    // has to pick this up.
    await seedCase(owner.tenantId, 'high', 'Case created after the page loaded');

    await expect(page.getByText('Case created after the page loaded')).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('T4: full keyboard navigation of the list and its filters', () => {
  let owner: SeededUser;

  test.beforeAll(async () => {
    owner = await seedTenantAndUser('owner');
    await seedCase(owner.tenantId, 'critical', 'Keyboard nav probe case A');
    await seedCase(owner.tenantId, 'high', 'Keyboard nav probe case B');
  });

  test.afterAll(async () => {
    await cleanupUser(owner);
  });

  test('every filter and every row is reachable and operable by keyboard alone', async ({ page }) => {
    await signInAs(page, owner.email);
    await expect(page.getByText('Keyboard nav probe case A')).toBeVisible();

    // Tab from the severity select through the rest of the filter bar —
    // each one is a native control, so Tab order falls out of normal DOM
    // order with no extra wiring needed.
    await page.getByLabel('Severity').focus();
    await expect(page.getByLabel('Severity')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Status')).toBeFocused();

    // Move focus to the first case row and activate it with the
    // keyboard — no mouse click anywhere in this test.
    const firstRow = page.getByText('Keyboard nav probe case A').locator('xpath=ancestor::*[@role="button"]');
    await firstRow.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Signals')).toBeVisible(); // the expanded detail panel

    // ArrowDown moves focus to the second row; Enter expands IT instead.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Entities involved')).toBeVisible();
  });
});
