/**
 * Runs before every test file — identical reasoning to
 * packages/ui/src/__tests__/setup.ts, which this app's own component
 * tests need too now that CaseDetail/CaseList render real markup.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
