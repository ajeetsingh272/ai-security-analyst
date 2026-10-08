'use client';

import { useState } from 'react';
import { ThemeToggleButton } from '@sentinel/ui';
import { THEME_COOKIE, type Theme } from '../lib/theme.js';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export interface ThemeToggleProps {
  /** The theme the root layout (a Server Component) already decided from
   * the cookie before this ever mounted — this is what makes the toggle's
   * initial render match the no-FOUC server-rendered `data-theme` instead
   * of defaulting to dark and flashing. */
  initialTheme: Theme;
}

export function ThemeToggle({ initialTheme }: ThemeToggleProps) {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  function handleToggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);

    const root = document.documentElement;
    if (next === 'light') root.setAttribute('data-theme', 'light');
    else root.removeAttribute('data-theme');

    // Non-httpOnly by design (lib/theme.ts) — this is the one piece of
    // state in the app a client component is allowed to persist directly,
    // rather than through a server round-trip.
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
  }

  return <ThemeToggleButton theme={theme} onToggle={handleToggle} />;
}
