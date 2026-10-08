/**
 * P6-06 T3 — against the real dashboard dev server and the real API
 * server, both started by playwright.config.ts's webServer, against
 * the real Postgres/Redis the dev stack provides.
 *
 * T1's own 200-client performance claim is proven for real at the
 * backend layer (apps/api/src/__tests__/msp.integration.test.ts —
 * 200 real tenants, 200 real per-tenant queries, timed) — this suite
 * proves the UI itself at a representative smaller scale instead,
 * since driving 200 real tenants through a real browser is a test-
 * suite-speed cost with no additional signal over the backend proof.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { test, expect } from '@playwright/test';
import { seedTenantAndUser, seedClientTenant, linkMspClient, seedCase, cleanupUser, cleanupTenant, TEST_PASSWORD, type SeededUser } from './fixtures.ts';

async function signInAs(page: import('@playwright/test').Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/cases');
}

test.describe('the MSP console', () => {
  let msp: SeededUser;
  let clientTenantId: string;

  test.beforeAll(async () => {
    msp = await seedTenantAndUser('admin');
    clientTenantId = await seedClientTenant('Linked client for P6-06 e2e');
    await linkMspClient(msp.tenantId, clientTenantId);
    await seedCase(clientTenantId, 'critical', "The client's own critical case");
    await seedCase(msp.tenantId, 'low', "The MSP's own unrelated case");
  });

  test.afterAll(async () => {
    await cleanupTenant(clientTenantId);
    await cleanupUser(msp);
  });

  test('AC1: ranks linked clients, AC3: search narrows the list', async ({ page }) => {
    await signInAs(page, msp.email);
    await page.goto('/msp');

    await expect(page.getByText('Linked client for P6-06 e2e')).toBeVisible();
    await expect(page.getByText('1 open critical')).toBeVisible();

    await page.getByLabel('Search clients').fill('nonexistent client name');
    await expect(page.getByText('Linked client for P6-06 e2e')).not.toBeVisible();
    await page.getByLabel('Search clients').fill('Linked client');
    await expect(page.getByText('Linked client for P6-06 e2e')).toBeVisible();
  });

  test('T3: drilling into a client enters its own scope cleanly, and returning restores the MSP\'s own scope', async ({ page }) => {
    await signInAs(page, msp.email);
    await page.goto('/msp');

    await page.getByRole('button', { name: /Open Linked client/ }).click();
    await page.waitForURL('**/cases');

    // AC2: cleanly scoped to the CLIENT's own cases, not the MSP's own.
    await expect(page.getByText("The client's own critical case")).toBeVisible();
    await expect(page.getByText("The MSP's own unrelated case")).not.toBeVisible();

    // The header's own tenant switcher is the "visibly" half of AC2 —
    // it now offers switching back to the MSP's own home tenant.
    const switcher = page.getByLabel('Current tenant');
    await expect(switcher).toBeVisible();
    await switcher.selectOption({ label: 'P6-01 e2e (admin)' });

    await expect(page.getByText("The MSP's own unrelated case")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("The client's own critical case")).not.toBeVisible();
  });
});
