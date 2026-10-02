/**
 * These tests enforce two accessibility guarantees that the UI/UX spec states
 * as binding. They are deliberately in CI rather than in a design review,
 * because a design review happens once and CI happens on every commit.
 *
 *   1. Every text/background pairing meets WCAG 2.1 AA.
 *   2. Severity is never distinguishable by hue alone.
 */

import { describe, expect, it } from 'vitest';
import { accent, lightTheme, severity, surface, text } from '../tokens';

type RGB = [number, number, number];

function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  const n = parseInt(
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h,
    16,
  );
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance. */
function luminance(rgb: RGB): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as RGB;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const l1 = luminance(hexToRgb(fg));
  const l2 = luminance(hexToRgb(bg));
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * CIE Lab, for perceptual difference.
 *
 * Note that WCAG contrast ratio is a luminance-only measure and is the WRONG
 * tool for asking "can a person tell these two colours apart" — two different
 * hues at the same lightness score ~1.0 while being obviously distinct. Use
 * contrast() for legibility against a background, and deltaE() for
 * distinguishability between two meaningful colours.
 */
function toLab(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as RGB;

  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;

  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIE76. Roughly: <2.3 is imperceptible, >20 is clearly distinguishable. */
function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

const CLEARLY_DISTINGUISHABLE = 20;

const AA_NORMAL = 4.5;
const AA_LARGE = 3.0;

describe('dark theme contrast', () => {
  const backgrounds = {
    void: surface.void,
    base: surface.base,
    raised: surface.raised,
    sunken: surface.sunken,
  };

  // text.disabled is excluded by design: the spec marks it non-text use only.
  const bodyText = {
    primary: text.primary,
    secondary: text.secondary,
    tertiary: text.tertiary,
  };

  for (const [bgName, bg] of Object.entries(backgrounds)) {
    for (const [fgName, fg] of Object.entries(bodyText)) {
      it(`${fgName} on ${bgName} meets AA normal text`, () => {
        expect(contrast(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL);
      });
    }
  }

  // Severity hues carry an icon and a label as well, so they are held to the
  // large-text/non-text threshold rather than AA normal.
  for (const [bgName, bg] of Object.entries(backgrounds)) {
    for (const [sevName, sev] of Object.entries(severity)) {
      it(`severity ${sevName} on ${bgName} meets AA large/non-text`, () => {
        expect(contrast(sev.hue, bg)).toBeGreaterThanOrEqual(AA_LARGE);
      });
    }
  }

  for (const [accName, acc] of Object.entries(accent)) {
    it(`accent ${accName} on base meets AA large/non-text`, () => {
      expect(contrast(acc, surface.base)).toBeGreaterThanOrEqual(AA_LARGE);
    });
  }
});

describe('light theme contrast', () => {
  const bodyText = {
    primary: lightTheme.text.primary,
    secondary: lightTheme.text.secondary,
    tertiary: lightTheme.text.tertiary,
  };

  for (const [bgName, bg] of Object.entries(lightTheme.surface)) {
    for (const [fgName, fg] of Object.entries(bodyText)) {
      it(`${fgName} on ${bgName} meets AA normal text`, () => {
        expect(contrast(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL);
      });
    }

    for (const [sevName, hue] of Object.entries(lightTheme.severity)) {
      it(`severity ${sevName} on ${bgName} meets AA large/non-text`, () => {
        expect(contrast(hue, bg)).toBeGreaterThanOrEqual(AA_LARGE);
      });
    }
  }
});

describe('severity is never hue-alone', () => {
  it('every severity has a distinct icon', () => {
    const icons = Object.values(severity).map((s) => s.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('every severity has a distinct label', () => {
    const labels = Object.values(severity).map((s) => s.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('every severity has a distinct rank for sorting', () => {
    const ranks = Object.values(severity).map((s) => s.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  /** Every severity pair must be clearly distinguishable to a trichromat. */
  it('severity hues are pairwise distinguishable', () => {
    const entries = Object.entries(severity);
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [nameA, a] = entries[i]!;
        const [nameB, b] = entries[j]!;
        const d = deltaE(a.hue, b.hue);
        expect(d, `${nameA} vs ${nameB} deltaE=${d.toFixed(1)}`).toBeGreaterThan(
          CLEARLY_DISTINGUISHABLE,
        );
      }
    }
  });

  /**
   * The ramp must also carry a lightness gradient, so ordering survives full
   * greyscale for someone with achromatopsia. This is a weaker guarantee than
   * the hue test above and is why icon and label are mandatory regardless:
   * some pairs (critical magenta vs info grey) are close in luminance and are
   * separated by shape and text, not by lightness.
   */
  it('adjacent severity ranks differ meaningfully in luminance', () => {
    const byRank = Object.values(severity).sort((a, b) => a.rank - b.rank);
    for (let i = 0; i < byRank.length - 1; i++) {
      const delta = Math.abs(
        luminance(hexToRgb(byRank[i]!.hue)) - luminance(hexToRgb(byRank[i + 1]!.hue)),
      );
      expect(delta).toBeGreaterThan(0.03);
    }
  });
});

describe('verified accent is reserved', () => {
  /**
   * `verified` means exactly one thing: a claim was re-queried against the
   * event store and the referenced event exists. If it ever becomes confusable
   * with a severity hue it stops being a unique signal, and the product's
   * central promise loses its visual anchor.
   */
  it('is clearly distinguishable from every severity hue', () => {
    for (const [name, s] of Object.entries(severity)) {
      const d = deltaE(accent.verified, s.hue);
      expect(d, `verified vs ${name} deltaE=${d.toFixed(1)}`).toBeGreaterThan(
        CLEARLY_DISTINGUISHABLE,
      );
    }
  });

  it('is clearly distinguishable from the signal accent', () => {
    expect(deltaE(accent.verified, accent.signal)).toBeGreaterThan(CLEARLY_DISTINGUISHABLE);
  });
});
