import { redirect } from 'next/navigation';
import { ErrorState, EmptyState } from '@sentinel/ui';
import { getCurrentUser } from '../../../lib/session.js';
import { roleAtLeast } from '../../../lib/nav-items.js';

// AC4/T4's literal test case: direct navigation to /settings by a role
// below admin must be refused HERE, server-side, before any settings data
// is fetched or rendered — not merely absent from the nav list one layout
// up. This is also NOT redundant with the (app) layout's own "no session"
// redirect (see cases/page.tsx's doc comment for why): Next streams this
// segment independently of that layout, so without re-checking here too, a
// request with no session at all would still get THIS page's real output
// racing the layout's redirect in the same response.
export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  if (!roleAtLeast(user.role, 'admin')) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="font-display text-display-m text-text-primary">Settings</h1>
        <ErrorState
          title="You don't have access to this page"
          description="Settings requires the admin or owner role. Ask a tenant owner to grant it if you need access."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-display text-display-m text-text-primary">Settings</h1>
      <EmptyState
        title="Tenant settings are coming in a later ticket"
        description="This screen is reachable only by admin and owner roles, enforced on the server — that enforcement is what P6-01 actually delivers here."
      />
    </div>
  );
}
