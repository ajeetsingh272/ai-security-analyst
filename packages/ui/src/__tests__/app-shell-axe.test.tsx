/**
 * P6-01 T3: axe accessibility checks pass on the dashboard shell
 * (AppShell + NavLink + ThemeToggleButton + TenantSwitcher) in both
 * themes. Same harness and the same documented jsdom carve-out as
 * app-shell's sibling components use — see axe.test.tsx's own comment.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import axe from 'axe-core';
import { AppShell } from '../AppShell.js';
import { NavLink } from '../NavLink.js';
import { ThemeToggleButton } from '../ThemeToggleButton.js';
import { TenantSwitcher } from '../TenantSwitcher.js';
import { THEMES } from './themes.js';

const LAYOUT_DEPENDENT_RULES = new Set(['color-contrast', 'color-contrast-enhanced']);

function Shell() {
  return (
    <AppShell
      header={
        <>
          <span>Sentinel</span>
          <TenantSwitcher
            current={{ id: 'a', name: 'Acme MSP' }}
            options={[
              { id: 'a', name: 'Acme MSP' },
              { id: 'b', name: 'Linked Client Co' },
            ]}
            onSwitch={() => {}}
          />
          <ThemeToggleButton theme="dark" onToggle={() => {}} />
        </>
      }
      nav={
        <>
          <NavLink href="/cases" label="Cases" active />
          <NavLink href="/connectors" label="Connectors" />
          <NavLink href="/reports" label="Reports" />
          <NavLink href="/settings" label="Settings" visible={false} />
        </>
      }
    >
      <h1>Open cases</h1>
      <p>Nothing needs your attention right now.</p>
    </AppShell>
  );
}

describe('accessibility (axe-core): dashboard shell', () => {
  for (const theme of THEMES) {
    it(`reports zero violations in ${theme} mode`, async () => {
      // Not routed through the shared `withTheme` harness: that helper's
      // try/finally resets `data-theme` the instant the callback RETURNS,
      // which for a synchronous callback is "after it ran" but for an
      // async one (render + axe.run, both needed here) is "before any of
      // this has actually happened yet." Set and restore it by hand here
      // instead of silently mismeasuring the wrong theme.
      const root = document.documentElement;
      const previous = root.getAttribute('data-theme');
      if (theme === 'light') root.setAttribute('data-theme', 'light');
      else root.removeAttribute('data-theme');

      try {
        const { container } = render(<Shell />);
        const results = await axe.run(container);

        if (results.violations.length > 0) {
          const detail = results.violations
            .map((v) => `${v.id}: ${v.help} (${v.nodes.length} node(s))`)
            .join('\n');
          throw new Error(`axe found ${results.violations.length} violation(s) in ${theme} mode:\n${detail}`);
        }
        expect(results.violations).toHaveLength(0);

        const unexpectedIncomplete = results.incomplete.filter((r) => !LAYOUT_DEPENDENT_RULES.has(r.id));
        if (unexpectedIncomplete.length > 0) {
          const detail = unexpectedIncomplete.map((r) => `${r.id}: ${r.help}`).join('\n');
          throw new Error(`axe found unexplained incomplete result(s) in ${theme} mode:\n${detail}`);
        }
      } finally {
        if (previous === null) root.removeAttribute('data-theme');
        else root.setAttribute('data-theme', previous);
      }
    });
  }
});
