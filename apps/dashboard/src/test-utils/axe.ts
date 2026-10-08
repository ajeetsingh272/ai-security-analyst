/**
 * P6-11 T1: the shared axe-core harness every route's own accessibility
 * test uses — extracted from the exact pattern CaseDetail.test.tsx
 * (P6-03) established first, so each new per-route test doesn't
 * reimplement the same theme loop and violation-reporting logic.
 */
import { expect } from 'vitest';
import { cleanup } from '@testing-library/react';
import axe from 'axe-core';

/** Runs the real axe-core engine against a rendered container and fails
 * with a readable per-violation summary — a bare `toHaveLength(0)`
 * failure on its own doesn't say WHICH rule failed or why. */
export async function expectNoAxeViolations(container: Element): Promise<void> {
  const results = await axe.run(container);
  if (results.violations.length > 0) {
    const detail = results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} node(s))`).join('\n');
    throw new Error(`axe found ${results.violations.length} violation(s):\n${detail}`);
  }
  expect(results.violations).toHaveLength(0);
}

/** Runs `check` once per theme this product ships (dark is the
 * default — no `data-theme` attribute; light sets it explicitly),
 * restoring whatever the attribute was before each run. Severity
 * colour tokens differ per theme (packages/design-tokens), so a
 * contrast violation in only one theme would otherwise go unnoticed. */
export async function forEachTheme(check: (theme: 'dark' | 'light') => Promise<void>): Promise<void> {
  for (const theme of ['dark', 'light'] as const) {
    const root = document.documentElement;
    const previous = root.getAttribute('data-theme');
    if (theme === 'light') root.setAttribute('data-theme', 'light');
    else root.removeAttribute('data-theme');

    try {
      await check(theme);
    } finally {
      if (previous === null) root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', previous);
      // Each iteration renders its own tree — without unmounting here,
      // the PREVIOUS theme's render is still in the DOM when the next
      // iteration renders again (the global `afterEach(cleanup)` only
      // runs BETWEEN separate `it()` blocks, not between iterations of
      // a loop inside one), so axe would scan both trees combined and
      // `findByText`-style queries would start matching duplicates.
      cleanup();
    }
  }
}
