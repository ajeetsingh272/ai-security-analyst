import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { AppShell } from '@sentinel/ui';
import { getCurrentUser } from '../../lib/session.js';
import { NAV_ITEMS, roleAtLeast } from '../../lib/nav-items.js';
import { THEME_COOKIE, isTheme } from '../../lib/theme.js';
import { Nav } from '../../components/Nav.client.js';
import { ThemeToggle } from '../../components/ThemeToggle.client.js';
import { TenantSwitcherClient } from '../../components/TenantSwitcherClient.js';
import { SignOutButton } from '../../components/SignOutButton.client.js';

// AC4/T4: the one place that decides "is there a real session at all" for
// every route this layout wraps. A visitor with no cookie, or an expired
// or revoked one, is redirected here BEFORE any child route segment's own
// page component runs — never rendered and hidden with CSS, which would
// still have shipped the markup to the client.
export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  const visibleItems = NAV_ITEMS.filter((item) => roleAtLeast(user.role, item.minRole));

  const cookieStore = await cookies();
  const cookieTheme = cookieStore.get(THEME_COOKIE)?.value;
  const initialTheme = isTheme(cookieTheme) ? cookieTheme : 'dark';

  const tenantOptions = user.isActingAsClient && user.homeTenantId
    ? [
        { id: user.tenantId, name: user.tenantName ?? user.tenantId },
        { id: user.homeTenantId, name: user.homeTenantName ?? 'Home tenant' },
      ]
    : [{ id: user.tenantId, name: user.tenantName ?? user.tenantId }];

  return (
    <AppShell
      header={
        <>
          <span className="font-display text-display-m text-text-primary">Sentinel</span>
          <div className="flex items-center gap-3">
            <TenantSwitcherClient current={tenantOptions[0]!} options={tenantOptions} />
            <ThemeToggle initialTheme={initialTheme} />
            <SignOutButton />
          </div>
        </>
      }
      nav={<Nav items={visibleItems} />}
    >
      {children}
    </AppShell>
  );
}
