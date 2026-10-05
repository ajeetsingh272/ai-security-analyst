#!/usr/bin/env tsx
/**
 * Generates CSS custom properties and a Tailwind v4 theme from tokens.ts.
 *
 * tokens.ts is the only source. Before this script existed, src/theme.css
 * carried its own header claiming to be "generated" while actually being
 * hand-maintained — true the day it was written, false the moment anyone
 * edited a value in only one of the two files. "One source" (P0-07 AC1) is a
 * property of the build, not a comment.
 *
 *   tsx scripts/build.mjs             regenerate both files
 *   tsx scripts/build.mjs --check     fail if committed output is stale
 *
 * This file imports tokens.ts directly (via tsx, which is how it must be run)
 * rather than re-stating any value, so there is exactly one place drift can
 * no longer happen.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import tokens, {
  surface,
  border,
  text,
  severity,
  accent,
  font,
  type,
  space,
  radius,
  motion,
  lightTheme,
} from '../src/tokens.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const CHECK = process.argv.includes('--check');

const BANNER = `/* GENERATED FILE — DO NOT EDIT BY HAND.
 * Produced by \`pnpm --filter @sentinel/design-tokens build\` from tokens.ts.
 * Edit tokens.ts and regenerate; an edit here is discarded on the next build. */
`;

// kebab-case key -> the --cr-space-N numeric keys stay numeric, everything else
// goes through this so `displayXl` style keys never sneak in as the token
// objects grow.
const kebab = (k) => String(k).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

// ── tokens.generated.css ──────────────────────────────────────────────────
//
// Variable names match the hand-authored block this replaces exactly — same
// --cr-bg-*, --cr-sev-*, --cr-text-* names theme.css and every component built
// on it already reference. Regenerating must not rename anything out from
// under its consumers.

const darkVars = [
  '  /* ── Surfaces ──────────────────────────────────────────────────────────── */',
  `  --cr-bg-void: ${surface.void};`,
  `  --cr-bg-base: ${surface.base};`,
  `  --cr-bg-raised: ${surface.raised};`,
  `  --cr-bg-sunken: ${surface.sunken};`,
  '',
  `  --cr-border-hairline: ${border.hairline};`,
  `  --cr-border-strong: ${border.strong};`,
  '',
  '  /* ── Text ──────────────────────────────────────────────────────────────── */',
  `  --cr-text-primary: ${text.primary};`,
  `  --cr-text-secondary: ${text.secondary};`,
  `  --cr-text-tertiary: ${text.tertiary};`,
  `  --cr-text-disabled: ${text.disabled};`,
  '',
  '  /* ── Severity (colour-blind-safe blue→magenta axis) ────────────────────── */',
  ...Object.entries(severity).map(([k, s]) => `  --cr-sev-${k}: ${s.hue};`),
  '',
  '  /* ── Accents (scarce by design) ────────────────────────────────────────── */',
  `  --cr-signal: ${accent.signal};`,
  '  /* Reserved exclusively for grounded evidence. Used nowhere else. */',
  `  --cr-verified: ${accent.verified};`,
  '',
  '  /* ── Type ──────────────────────────────────────────────────────────────── */',
  `  --cr-font-display: ${font.display};`,
  `  --cr-font-ui: ${font.ui};`,
  `  --cr-font-mono: ${font.mono};`,
  '',
  ...Object.entries(type).map(([k, t]) => `  --cr-text-${kebab(k)}: ${t.size};`),
  '',
  '  /* ── Space ─────────────────────────────────────────────────────────────── */',
  // Every key, not a subset: the Tailwind theme below references --cr-space-*
  // for every key in `space`, so an arbitrary cutoff here leaves one of its
  // var() references resolving to nothing — which is exactly how the first
  // version of this script emitted a theme where --spacing-20 and --spacing-24
  // pointed at a custom property that was never defined.
  ...Object.entries(space)
    .filter(([k]) => Number(k) > 0)
    .map(([k, v]) => `  --cr-space-${k}: ${v};`),
  '',
  `  --cr-radius-sm: ${radius.sm};`,
  `  --cr-radius-md: ${radius.md};`,
  `  --cr-radius-lg: ${radius.lg};`,
  `  --cr-radius-xl: ${radius.xl};`,
  `  --cr-radius-full: ${radius.full};`,
  '',
  '  /* ── Density (default: comfortable) ────────────────────────────────────── */',
  `  --cr-row-height: ${tokens.density.comfortable.rowHeight};`,
  `  --cr-section-gap: var(--cr-space-8);`,
  `  --cr-card-padding: var(--cr-space-6);`,
  '',
  '  /* ── Motion ────────────────────────────────────────────────────────────── */',
  `  --cr-motion-instant: ${motion.instant.duration} ${motion.instant.easing};`,
  `  --cr-motion-quick: ${motion.quick.duration} ${motion.quick.easing};`,
  `  --cr-motion-considered: ${motion.considered.duration} ${motion.considered.easing};`,
  `  --cr-stagger: ${motion.stagger};`,
].join('\n');

const compactVars = [
  `  --cr-row-height: ${tokens.density.compact.rowHeight};`,
  `  --cr-section-gap: var(--cr-space-5);`,
  `  --cr-card-padding: var(--cr-space-4);`,
].join('\n');

const lightVars = [
  `  --cr-bg-void: ${lightTheme.surface.void};`,
  `  --cr-bg-base: ${lightTheme.surface.base};`,
  `  --cr-bg-raised: ${lightTheme.surface.raised};`,
  `  --cr-bg-sunken: ${lightTheme.surface.sunken};`,
  '',
  `  --cr-border-hairline: ${lightTheme.border.hairline};`,
  `  --cr-border-strong: ${lightTheme.border.strong};`,
  '',
  `  --cr-text-primary: ${lightTheme.text.primary};`,
  `  --cr-text-secondary: ${lightTheme.text.secondary};`,
  `  --cr-text-tertiary: ${lightTheme.text.tertiary};`,
  `  --cr-text-disabled: ${lightTheme.text.disabled};`,
  '',
  ...Object.entries(lightTheme.severity).map(([k, v]) => `  --cr-sev-${k}: ${v};`),
  '',
  `  --cr-signal: ${lightTheme.accent.signal};`,
  `  --cr-verified: ${lightTheme.accent.verified};`,
].join('\n');

const tokensCss = `${BANNER}
:root {
${darkVars}
}

[data-density='compact'] {
${compactVars}
}

/* Severity hues shift in lightness, never in hue, so the learned
   colour-to-meaning mapping survives the theme switch. */
[data-theme='light'] {
${lightVars}
}
`;

// ── tailwind.generated.css ───────────────────────────────────────────────
//
// Tailwind v4's own theme configuration is CSS, via @theme — not a JS config
// object. This re-exposes the same --cr-* custom properties under the
// --color-*, --font-*, --spacing-*, --radius-* namespaces Tailwind's utility
// generator reads, with `inline` so it resolves the --cr-* variable at
// utility-generation time rather than copying its value — a [data-theme] or
// [data-density] switch on an ancestor still repaints every utility built
// from these tokens, which a non-inline @theme would not do.

function themeVars(prefix, entries) {
  return entries.map(([k, cssVar]) => `  --${prefix}-${k}: var(${cssVar});`).join('\n');
}

const tailwindCss = `${BANNER}
@theme inline {
${themeVars('color', [
  ['surface-void', '--cr-bg-void'],
  ['surface-base', '--cr-bg-base'],
  ['surface-raised', '--cr-bg-raised'],
  ['surface-sunken', '--cr-bg-sunken'],
  ['border-hairline', '--cr-border-hairline'],
  ['border-strong', '--cr-border-strong'],
  ['text-primary', '--cr-text-primary'],
  ['text-secondary', '--cr-text-secondary'],
  ['text-tertiary', '--cr-text-tertiary'],
  ['text-disabled', '--cr-text-disabled'],
  ...Object.keys(severity).map((k) => [`severity-${k}`, `--cr-sev-${k}`]),
  ['signal', '--cr-signal'],
  ['verified', '--cr-verified'],
])}

${themeVars('font', [
  ['display', '--cr-font-display'],
  ['ui', '--cr-font-ui'],
  ['mono', '--cr-font-mono'],
])}

${themeVars(
  'spacing',
  Object.keys(space)
    .filter((k) => Number(k) > 0)
    .map((k) => [k, `--cr-space-${k}`]),
)}

${themeVars('radius', [
  ['sm', '--cr-radius-sm'],
  ['md', '--cr-radius-md'],
  ['lg', '--cr-radius-lg'],
  ['xl', '--cr-radius-xl'],
  ['full', '--cr-radius-full'],
])}
}
`;

// Every --cr-* reference tailwind.generated.css makes must resolve against a
// custom property tokens.generated.css actually defines in :root. Caught by
// hand once already — --spacing-20/24 pointed at --cr-space-20/24 before the
// darkVars filter above included them — so it is an assertion now, not a
// review habit.
const definedInRoot = new Set(
  [...darkVars.matchAll(/--cr-[\w-]+(?=:)/g)].map((m) => m[0]),
);
const referenced = [...tailwindCss.matchAll(/var\((--cr-[\w-]+)\)/g)].map((m) => m[1]);
const dangling = referenced.filter((v) => !definedInRoot.has(v));
if (dangling.length > 0) {
  console.error(
    `build: tailwind.generated.css references undefined custom propert${
      dangling.length === 1 ? 'y' : 'ies'
    }: ${[...new Set(dangling)].join(', ')}`,
  );
  process.exit(1);
}

const outputs = {
  'tokens.generated.css': tokensCss,
  'tailwind.generated.css': tailwindCss,
};

let stale = [];
for (const [name, content] of Object.entries(outputs)) {
  const path = join(SRC, name);
  if (CHECK) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== content) stale.push(name);
  } else {
    writeFileSync(path, content, 'utf8');
    console.log(`build: wrote ${name}`);
  }
}

if (CHECK) {
  if (stale.length > 0) {
    console.error(
      `build --check: out of date: ${stale.join(', ')}\n` +
        '  tokens.ts changed without regenerating. Run: pnpm --filter @sentinel/design-tokens build',
    );
    process.exit(1);
  }
  console.log('build --check: up to date');
}
