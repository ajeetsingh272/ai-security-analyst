/**
 * P6-01 T2 — theme preference persists across sessions. "Session" here
 * means a real new browser context built from saved storage state (the
 * theme cookie), not just a client-side re-render in the same page — the
 * point is that the SERVER renders the right theme on first paint for a
 * returning visitor, before any client script runs.
 */
import { test, expect } from '@playwright/test';
import { seedTenantAndUser, cleanupUser, TEST_PASSWORD, type SeededUser } from './fixtures.ts';

let user: SeededUser;

test.beforeAll(async () => {
  user = await seedTenantAndUser('owner');
});

test.afterAll(async () => {
  await cleanupUser(user);
});

test('switching to light mode persists into a brand new browser session', async ({ browser }) => {
  const firstContext = await browser.newContext();
  const firstPage = await firstContext.newPage();

  await firstPage.goto('/sign-in');
  await firstPage.getByLabel('Email').fill(user.email);
  await firstPage.getByLabel('Password').fill(TEST_PASSWORD);
  await firstPage.getByRole('button', { name: 'Sign in' }).click();
  await firstPage.waitForURL('**/cases');

  // Dark is the default — confirm the starting point before changing it.
  await expect(firstPage.locator('html')).not.toHaveAttribute('data-theme', 'light');

  await firstPage.getByRole('button', { name: 'Switch to light mode' }).click();
  await expect(firstPage.locator('html')).toHaveAttribute('data-theme', 'light');

  const storageState = await firstContext.storageState();
  await firstContext.close();

  // A genuinely new browser context built only from the saved cookies —
  // the closest Playwright equivalent to "closed the laptop, opened it
  // again later."
  const secondContext = await browser.newContext({ storageState });
  const secondPage = await secondContext.newPage();
  const response = await secondPage.goto('/cases');

  // The server-rendered HTML itself (not a client-side re-render) must
  // already carry data-theme="light" — proof this is read from the cookie
  // in the root layout, not merely restored by client JS after paint.
  const html = await response!.text();
  expect(html).toMatch(/<html[^>]*data-theme="light"/);

  await expect(secondPage.locator('html')).toHaveAttribute('data-theme', 'light');
  await secondContext.close();
});
