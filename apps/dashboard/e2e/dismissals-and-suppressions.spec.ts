/**
 * P6-08 (TG3: "Nothing is hidden — dismissals are surfaced") — against
 * the real dashboard dev server and the real API server
 * (playwright.config.ts's webServer), against the real Postgres the
 * dev stack provides. The backend half of this ticket (the digest
 * query, the challenge transition, suppression CRUD) is already proven
 * at the integration layer (apps/api/src/__tests__/dismissals.
 * integration.test.ts, suppressions.integration.test.ts, both P3-07/
 * P2-10) — this suite proves the dashboard's own wiring to those real
 * endpoints, not the backend logic a second time.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { test, expect } from '@playwright/test';
import { seedTenantAndUser, seedDismissedCase, seedSuppression, cleanupUser, TEST_PASSWORD, type SeededUser } from './fixtures.ts';

async function signInAs(page: import('@playwright/test').Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/cases');
}

test.describe('dismissal digest', () => {
  let analyst: SeededUser;

  test.beforeAll(async () => {
    analyst = await seedTenantAndUser('analyst');
    await seedDismissedCase(analyst.tenantId, 'system', 'below_escalation_threshold', 'A rule-dismissed case');
    await seedDismissedCase(analyst.tenantId, 'ai', 'Benign: known-good admin maintenance window', 'An AI-dismissed case');
  });

  test.afterAll(async () => {
    await cleanupUser(analyst);
  });

  test('T1: dismissals are listed with their reasons, distinguishing a rule from the AI', async ({ page }) => {
    await signInAs(page, analyst.email);
    await page.goto('/dismissals');

    await expect(page.getByText('below_escalation_threshold')).toBeVisible();
    await expect(page.getByText('Benign: known-good admin maintenance window')).toBeVisible();
    await expect(page.getByText('Rule')).toBeVisible();
    await expect(page.getByText('Sentinel AI')).toBeVisible();
  });

  test('T2: challenging a dismissal reopens the case', async ({ page }) => {
    await signInAs(page, analyst.email);
    await page.goto('/dismissals');

    await page.getByRole('link', { name: /Browse these dismissed cases/ }).first().click();
    await page.waitForURL('**/cases?**');

    await page.getByText('A rule-dismissed case').click();
    await page.getByRole('link', { name: 'View full case →' }).click();
    await page.waitForURL('**/cases/*');

    await expect(page.getByText('Dismissed by a rule')).toBeVisible();
    await page.getByLabel('Reason for challenging this dismissal').fill('This looks like real suspicious activity, not noise.');
    await page.getByRole('button', { name: 'Challenge dismissal' }).click();

    await expect(page.getByText('Dismissed by a rule')).not.toBeVisible({ timeout: 10_000 });
  });
});

test.describe('suppression management', () => {
  let analyst: SeededUser;

  test.beforeAll(async () => {
    analyst = await seedTenantAndUser('analyst');
    await seedSuppression(analyst.tenantId, analyst.userId, 'noisy_login_rule', 'Known noisy VPN egress IP, tracked in ticket OPS-123');
  });

  test.afterAll(async () => {
    await cleanupUser(analyst);
  });

  test('active suppressions are listed with their creator, reason and expiry', async ({ page }) => {
    await signInAs(page, analyst.email);
    await page.goto('/suppressions');

    await expect(page.getByText('noisy_login_rule')).toBeVisible();
    await expect(page.getByText('Known noisy VPN egress IP, tracked in ticket OPS-123')).toBeVisible();
    await expect(page.getByText(analyst.email)).toBeVisible();
  });

  test('T3: revoking a suppression removes it from the active list', async ({ page }) => {
    await signInAs(page, analyst.email);
    await page.goto('/suppressions');

    await expect(page.getByText('noisy_login_rule')).toBeVisible();
    await page.getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByText('noisy_login_rule')).not.toBeVisible({ timeout: 10_000 });
  });
});
