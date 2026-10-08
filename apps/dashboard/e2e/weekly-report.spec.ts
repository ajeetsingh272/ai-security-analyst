/**
 * P6-07 — against the real dashboard dev server and the real API
 * server (playwright.config.ts's webServer), against the real
 * Postgres the dev stack provides. The PDF rendering itself (T3) is
 * proven at the backend layer (weekly-report-render.test.ts's own
 * %PDF- magic-byte check); this suite proves the download link's own
 * wiring and the admin-only schedule/generate controls' visibility,
 * not the PDF bytes a second time.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { test, expect } from '@playwright/test';
import { seedTenantAndUser, seedCase, seedWeeklyReport, cleanupUser, TEST_PASSWORD, type SeededUser } from './fixtures.ts';

async function signInAs(page: import('@playwright/test').Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/cases');
}

test.describe('weekly reports — admin', () => {
  let admin: SeededUser;

  test.beforeAll(async () => {
    admin = await seedTenantAndUser('admin');
    await seedCase(admin.tenantId, 'critical', 'A real case for the weekly report window');
  });

  test.afterAll(async () => {
    await cleanupUser(admin);
  });

  test('AC1/AC2: generating now produces a real report with a headline, improvement, and PDF link; AC1: the schedule is manageable', async ({ page }) => {
    await signInAs(page, admin.email);
    await page.goto('/reports');

    await expect(page.getByText('No reports yet')).toBeVisible();
    await page.getByRole('button', { name: 'Generate now' }).click();

    await expect(page.getByText(/Sentinel caught 1 thing/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('link', { name: 'Download PDF' })).toBeVisible();

    const daySelect = page.getByLabel('Day of week');
    await expect(daySelect).toBeVisible();
    await daySelect.selectOption({ label: 'Wednesday' });
    await expect(daySelect).toHaveValue('3');

    const enabledToggle = page.getByLabel('Send the weekly report automatically');
    await expect(enabledToggle).toBeChecked();
    await enabledToggle.uncheck();
    await expect(enabledToggle).not.toBeChecked();
  });
});

test.describe('weekly reports — read_only', () => {
  let viewer: SeededUser;

  test.beforeAll(async () => {
    viewer = await seedTenantAndUser('read_only');
    await seedWeeklyReport(viewer.tenantId, 'Nothing serious happened this week. Sentinel noted 2 small items. None needed action.', null);
  });

  test.afterAll(async () => {
    await cleanupUser(viewer);
  });

  test("AC3: a read_only viewer sees the report but no generate button or schedule controls they can't use", async ({ page }) => {
    await signInAs(page, viewer.email);
    await page.goto('/reports');

    await expect(page.getByText(/Nothing serious happened this week/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate now' })).not.toBeVisible();
    await expect(page.getByText('Schedule')).not.toBeVisible();
  });
});
