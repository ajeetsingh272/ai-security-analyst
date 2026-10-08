import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { THEME_COOKIE, isTheme } from '../lib/theme.js';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sentinel',
  description: 'Autonomous SOC console',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const cookieTheme = cookieStore.get(THEME_COOKIE)?.value;
  // Dark is the implicit default (AC2) — the `data-theme` attribute is
  // added only to opt INTO light, never to assert dark explicitly. Read
  // here, server-side, before first paint, so there is no flash of the
  // wrong theme while a client script catches up.
  const theme = isTheme(cookieTheme) ? cookieTheme : 'dark';

  return (
    <html lang="en" data-theme={theme === 'light' ? 'light' : undefined}>
      <body>{children}</body>
    </html>
  );
}
