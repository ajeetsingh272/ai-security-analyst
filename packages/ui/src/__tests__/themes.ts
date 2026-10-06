/**
 * Shared harness for "renders correctly in both themes" (P0-08 AC3). The
 * repo's theme switch is `data-theme` on an ancestor, read by the generated
 * CSS custom properties — so testing it means setting that attribute on the
 * document and asserting against computed values, not re-implementing the
 * token logic in the test.
 */
export type ThemeName = 'dark' | 'light';

export const THEMES: ThemeName[] = ['dark', 'light'];

export function withTheme<T>(theme: ThemeName, run: () => T): T {
  const root = document.documentElement;
  const previous = root.getAttribute('data-theme');
  if (theme === 'light') root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme');
  try {
    return run();
  } finally {
    if (previous === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', previous);
  }
}
