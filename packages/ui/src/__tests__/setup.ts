/**
 * Runs before every test file. `@testing-library/jest-dom` adds DOM-aware
 * matchers (`toBeVisible`, `toHaveFocus`) that the component tests rely on —
 * without this import they would fail with "not a function", not a wrong
 * assertion, which is a worse debugging experience than a clear setup error.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmounts every rendered component after each test. Without this, a
// component left mounted from test N is still in the DOM when test N+1 runs
// `screen.getByRole(...)`, and "found two matching elements" starts pointing
// at the wrong test.
afterEach(() => {
  cleanup();
});
