/**
 * Control Room — design tokens.
 *
 * The single source of truth for every colour, type, space and motion value in
 * the product. CSS custom properties and the Tailwind theme are both generated
 * from this file by `pnpm build`. Never hardcode a value downstream; a lint rule
 * rejects it.
 *
 * See docs/design/ui-ux-spec.md for the reasoning behind these choices.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Surfaces — four layers of near-black with a blue cast.
// Depth comes from layering and hairlines, never from shadow on dark surfaces.
// ─────────────────────────────────────────────────────────────────────────────

export const surface = {
  void: '#070A11',
  base: '#0C111C',
  raised: '#131A28',
  sunken: '#04060B',
} as const;

export const border = {
  hairline: 'rgba(255, 255, 255, 0.08)',
  strong: 'rgba(255, 255, 255, 0.16)',
} as const;

export const text = {
  primary: '#E8ECF4',
  secondary: '#9BA6BA',
  tertiary: '#7A849A',
  disabled: '#3C465C',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Severity — colour-blind-safe ramp.
//
// Deliberately NOT green→yellow→red: that ramp collapses into indistinguishable
// yellows under deuteranopia and protanopia (~8% of men). This runs along a
// blue→magenta axis, which survives both, and carries a strong lightness
// gradient so the ordering holds in full greyscale.
//
// `icon` and `label` are part of the token, not decoration. Severity is never
// communicated by hue alone — the component API renders all three and offers no
// colour-only variant.
// ─────────────────────────────────────────────────────────────────────────────

export const severity = {
  critical: { hue: '#FF3D6E', icon: 'octagon', label: 'Critical', rank: 4, greyL: 58 },
  high: { hue: '#FF8A3D', icon: 'triangle', label: 'High', rank: 3, greyL: 71 },
  medium: { hue: '#F5C544', icon: 'diamond', label: 'Medium', rank: 2, greyL: 82 },
  low: { hue: '#3DBFF2', icon: 'circle', label: 'Low', rank: 1, greyL: 74 },
  info: { hue: '#777F8F', icon: 'circle-outline', label: 'Info', rank: 0, greyL: 62 },
} as const;

export type SeverityKey = keyof typeof severity;

// ─────────────────────────────────────────────────────────────────────────────
// Accents — scarce by design.
//
// `verified` is reserved for ONE meaning: this claim was re-queried against the
// event store and the referenced event exists. It is used for nothing else —
// not success toasts, not healthy connectors, not passing checks. Reserving a
// colour for the product's central promise makes that promise visible, and
// makes its absence conspicuous.
// ─────────────────────────────────────────────────────────────────────────────

export const accent = {
  signal: '#34D1F0',
  verified: '#4ADE9B',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Typography
// ─────────────────────────────────────────────────────────────────────────────

export const font = {
  display: "'Bricolage Grotesque', 'Archivo', system-ui, sans-serif",
  ui: "'Archivo', system-ui, -apple-system, sans-serif",
  /** Mono means machine fact. Every value the system did not write in prose. */
  mono: "'IBM Plex Mono', ui-monospace, 'SF Mono', monospace",
} as const;

export const type = {
  'display-xl': { size: '3.5rem', lh: '1.02', weight: 700, family: 'display', tracking: '-0.03em' },
  'display-l': { size: '2.375rem', lh: '1.08', weight: 700, family: 'display', tracking: '-0.02em' },
  'display-m': { size: '1.6875rem', lh: '1.15', weight: 600, family: 'display', tracking: '-0.01em' },
  /** The AI report. The only text in the product read as prose. 68ch measure. */
  'body-l': { size: '1.0625rem', lh: '1.55', weight: 400, family: 'ui', tracking: '0' },
  'body-m': { size: '0.875rem', lh: '1.55', weight: 400, family: 'ui', tracking: '0' },
  'body-s': { size: '0.8125rem', lh: '1.45', weight: 400, family: 'ui', tracking: '0' },
  label: { size: '0.6875rem', lh: '1.2', weight: 600, family: 'ui', tracking: '0.08em' },
  'mono-m': { size: '0.8125rem', lh: '1.5', weight: 400, family: 'mono', tracking: '0' },
  'mono-s': { size: '0.71875rem', lh: '1.45', weight: 400, family: 'mono', tracking: '0' },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Space — 4px base
// ─────────────────────────────────────────────────────────────────────────────

export const space = {
  0: '0', 1: '0.25rem', 2: '0.5rem', 3: '0.75rem', 4: '1rem',
  5: '1.25rem', 6: '1.5rem', 8: '2rem', 10: '2.5rem', 12: '3rem',
  16: '4rem', 20: '5rem', 24: '6rem',
} as const;

/**
 * Two densities sharing one token set. Comfortable serves the owner on a phone;
 * compact serves the MSP analyst watching 200 tenants. The MSP console defaults
 * to compact regardless of viewport — 200 clients at comfortable density is a
 * scrolling exercise, not a monitoring surface.
 */
export const density = {
  comfortable: { rowHeight: '3.5rem', sectionGap: space[8], cardPadding: space[6], baseType: 'body-m' },
  compact: { rowHeight: '2.25rem', sectionGap: space[5], cardPadding: space[4], baseType: 'body-s' },
} as const;

export const radius = {
  none: '0', sm: '0.25rem', md: '0.375rem', lg: '0.5rem', xl: '0.75rem', full: '9999px',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Motion — restraint is the policy.
//
// Frivolous motion in a security product reads as unserious. Nothing bounces,
// springs, or slides in from off-screen. `pulse` is the only persistent
// animation and belongs solely to the live indicator.
// ─────────────────────────────────────────────────────────────────────────────

export const motion = {
  instant: { duration: '80ms', easing: 'cubic-bezier(0, 0, 0.2, 1)' },
  quick: { duration: '160ms', easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
  considered: { duration: '280ms', easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  pulse: { duration: '3000ms', easing: 'cubic-bezier(0.4, 0, 0.6, 1)' },
  /** New cases enter a list with this stagger — enough to notice, not a performance. */
  stagger: '40ms',
} as const;

/**
 * Light theme. Not the default and not expected to see heavy use — it exists
 * for printed reports, bright MSP floors, and users who need it. Severity hues
 * shift in lightness, never in hue, so the learned colour-to-meaning mapping
 * survives the switch.
 */
export const lightTheme = {
  surface: { void: '#F7F8FA', base: '#FFFFFF', raised: '#F0F2F6', sunken: '#EBEEF3' },
  border: { hairline: 'rgba(10, 14, 22, 0.10)', strong: 'rgba(10, 14, 22, 0.20)' },
  text: { primary: '#0C111C', secondary: '#4A5568', tertiary: '#626D7D', disabled: '#A3ACBD' },
  severity: {
    critical: '#C70038', high: '#B45309', medium: '#8A6400', low: '#0369A1', info: '#54606F',
  },
  accent: { signal: '#0E7F99', verified: '#15803D' },
} as const;

export const tokens = {
  surface, border, text, severity, accent, font, type, space, density, radius, motion, lightTheme,
} as const;

export default tokens;
