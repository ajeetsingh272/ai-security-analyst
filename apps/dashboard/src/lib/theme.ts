/**
 * Theme persistence (P6-01 AC2/T2): a plain, non-httpOnly cookie — unlike
 * the session cookie, "which theme" carries no security weight, so the
 * client-side toggle can set it directly via `document.cookie` with no
 * server round-trip, and the root layout (a Server Component) can read it
 * before first paint to set `data-theme` with no flash of the wrong theme.
 */
export const THEME_COOKIE = 'sentinel_theme';
export type Theme = 'dark' | 'light';

export function isTheme(value: string | undefined): value is Theme {
  return value === 'dark' || value === 'light';
}
