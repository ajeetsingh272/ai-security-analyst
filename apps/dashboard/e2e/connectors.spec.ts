/**
 * P6-04 — against the real dashboard dev server and the real API
 * server, both started by playwright.config.ts's webServer, against
 * the real Postgres/Redis the dev stack provides.
 *
 * T1's own real-Microsoft hop (the browser's top-level navigation to
 * login.microsoftonline.com and back) cannot be driven here — there is
 * no real Entra app registration in this sandbox, and Playwright has no
 * real Microsoft test-tenant credentials to complete that login with.
 * The backend half of that flow (connect -> callback -> encrypted
 * credential storage) is proven for real against a mock Microsoft
 * token endpoint in apps/api/src/__tests__/m365-connector.integration.
 * test.ts; what's tested here is everything the wizard itself controls:
 * the pre-connection explanation, the post-callback success/error
 * banners (navigated to directly, simulating landing there after a real
 * redirect), the connected state, and T2's own recovery guidance.
 *
 * Requires: pnpm dev:stack && pnpm db:migrate.
 */
import { test, expect } from '@playwright/test';
import { seedTenantAndUser, seedConnector, cleanupUser, TEST_PASSWORD, type SeededUser } from './fixtures.ts';

async function signInAs(page: import('@playwright/test').Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/cases');
}

test.describe('AC1: plain-language permission explanation when not yet connected', () => {
  let owner: SeededUser;

  test.beforeAll(async () => {
    owner = await seedTenantAndUser('owner');
  });

  test.afterAll(async () => {
    await cleanupUser(owner);
  });

  test('explains every requested permission and what Sentinel does not ask for', async ({ page }) => {
    await signInAs(page, owner.email);
    await page.goto('/connectors');

    await expect(page.getByText('Read your Microsoft 365 activity logs')).toBeVisible();
    await expect(page.getByText('Reading or sending email content')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Connect Microsoft 365' })).toBeVisible();
  });
});

test.describe('AC2/AC4: connected status and disconnect explanation', () => {
  let owner: SeededUser;

  test.beforeAll(async () => {
    owner = await seedTenantAndUser('owner');
    await seedConnector(owner.tenantId, 'healthy');
  });

  test.afterAll(async () => {
    await cleanupUser(owner);
  });

  test('shows connection status, and disconnecting explains exactly what stops happening before it happens', async ({ page }) => {
    await signInAs(page, owner.email);
    await page.goto('/connectors');

    await expect(page.getByText('Connected', { exact: true })).toBeVisible();
    await expect(page.getByText(/Last synced/)).toBeVisible();

    await page.getByRole('button', { name: 'Disconnect' }).click();
    await expect(page.getByText('Stop reading new sign-in and admin activity')).toBeVisible();
    await expect(page.getByText('You can reconnect at any time.')).toBeVisible();

    await page.getByRole('button', { name: 'Yes, disconnect' }).click();
    await expect(page.getByText('Needs attention')).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('AC3/T2: a revoked connection surfaces actionable recovery guidance', () => {
  let owner: SeededUser;

  test.beforeAll(async () => {
    owner = await seedTenantAndUser('owner');
    await seedConnector(owner.tenantId, 'revoked');
  });

  test.afterAll(async () => {
    await cleanupUser(owner);
  });

  test('explains what happened in plain language and offers reconnection', async ({ page }) => {
    await signInAs(page, owner.email);
    await page.goto('/connectors');

    await expect(page.getByText('Microsoft 365 access was turned off')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Reconnect Microsoft 365' })).toBeVisible();
  });
});

test.describe('the OAuth callback redirect lands on a state the wizard can render', () => {
  let owner: SeededUser;

  test.beforeAll(async () => {
    owner = await seedTenantAndUser('owner');
  });

  test.afterAll(async () => {
    await cleanupUser(owner);
  });

  test('a successful-callback redirect shows the connected banner', async ({ page }) => {
    await signInAs(page, owner.email);
    await page.goto('/connectors?m365=connected');
    await expect(page.getByText('Microsoft 365 is connected.')).toBeVisible();
  });

  test('a declined-consent redirect explains nothing was changed', async ({ page }) => {
    await signInAs(page, owner.email);
    await page.goto('/connectors?m365=error&reason=consent_declined');
    await expect(page.getByText('nothing was changed')).toBeVisible();
  });
});
