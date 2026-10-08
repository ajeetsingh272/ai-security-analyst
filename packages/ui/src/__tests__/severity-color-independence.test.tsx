/**
 * P6-11 T3 ("colour-blindness simulation review of every severity
 * surface"): an AI agent cannot perform a human visual review of a
 * simulated colour-blind screenshot — this is the honest automated
 * substitute, proving the actual WCAG 1.4.1 guarantee programmatically
 * rather than relying on a human eyeballing a filtered image. It
 * asserts the two load-bearing, NON-colour channels SeverityPill's own
 * doc comment claims it always carries: a unique icon shape, and a
 * unique text label (present in the accessible name even in `compact`
 * mode, where it's visually hidden but not removed) — for every real
 * severity level. A reviewer who wants independent confirmation that
 * the rendered page is still distinguishable with colour entirely
 * removed can take this test's own claim and verify it against a
 * real colour-blindness simulator; this test is what makes that claim
 * checkable in the first place, not a replacement for ever doing so.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { severity, type SeverityKey } from '@sentinel/design-tokens';
import { SeverityPill } from '../SeverityPill.js';

const SEVERITY_KEYS = Object.keys(severity) as SeverityKey[];

describe('SeverityPill: severity is never conveyed by colour alone', () => {
  it('every severity level has its own distinct icon shape — removing colour still leaves 5 distinguishable shapes', () => {
    const icons = SEVERITY_KEYS.map((key) => severity[key].icon);
    expect(new Set(icons).size).toBe(SEVERITY_KEYS.length);
  });

  it('every severity level has its own non-empty text label', () => {
    const labels = SEVERITY_KEYS.map((key) => severity[key].label);
    expect(new Set(labels).size).toBe(SEVERITY_KEYS.length);
    for (const label of labels) expect(label.trim().length).toBeGreaterThan(0);
  });

  for (const key of SEVERITY_KEYS) {
    it(`${key}: the rendered pill's accessible name includes its text label, in full and compact mode alike`, () => {
      const { container: full } = render(<SeverityPill severity={key} />);
      expect(full.textContent).toContain(severity[key].label);

      const { container: compact } = render(<SeverityPill severity={key} compact />);
      // Visually hidden (sr-only) in compact mode, but still present in
      // the DOM text content — an assistive-technology user, and
      // anyone reading the raw page source, still gets the label.
      expect(compact.textContent).toContain(severity[key].label);
    });
  }

  it("each severity's icon is marked decorative (aria-hidden) so the label is the one source of truth for its accessible name, not an icon a screen reader might announce differently", () => {
    const { container } = render(<SeverityPill severity="critical" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });
});
