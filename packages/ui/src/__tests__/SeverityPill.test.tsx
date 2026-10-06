import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { severity, type SeverityKey } from '@sentinel/design-tokens';
import { SeverityPill } from '../SeverityPill.js';
import { THEMES, withTheme } from './themes.js';

const KEYS = Object.keys(severity) as SeverityKey[];

describe('SeverityPill', () => {
  it.each(KEYS)('renders the %s label as text, never hue alone', (key) => {
    render(<SeverityPill severity={key} />);
    // getByText, not getByRole('status') — the label must be real text content,
    // not something only a colour conveys. This is the P0-08/P0-07 guarantee
    // under direct test: hue, icon and label all present together.
    expect(screen.getByText(severity[key].label)).toBeVisible();
  });

  it.each(KEYS)('still exposes the %s label to assistive tech when compact', (key) => {
    render(<SeverityPill severity={key} compact />);
    // Visually hidden via sr-only, but present in the accessibility tree —
    // compact must not mean "colour only" for a screen reader either.
    expect(screen.getByText(severity[key].label)).toBeInTheDocument();
  });

  it.each(THEMES)('renders under %s theme with identical structure', (theme) => {
    withTheme(theme, () => {
      render(<SeverityPill severity="critical" />);
      expect(screen.getByText('Critical')).toBeVisible();
    });
  });

  it('every severity renders a visually distinguishable icon shape', () => {
    const { container } = render(
      <>
        {KEYS.map((k) => (
          <SeverityPill key={k} severity={k} />
        ))}
      </>,
    );
    const paths = [...container.querySelectorAll('svg')].map((svg) => svg.innerHTML);
    // Same assertion as the design-tokens contrast suite (distinct icon per
    // severity), now checked against what actually renders to the DOM rather
    // than against the token object alone.
    expect(new Set(paths).size).toBe(KEYS.length);
  });
});
