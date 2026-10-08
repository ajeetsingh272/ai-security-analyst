import { redirect } from 'next/navigation';
import { ErrorState } from '@sentinel/ui';
import { getCurrentUser } from '../../../lib/session.js';
import { roleAtLeast } from '../../../lib/nav-items.js';
import { MspConsole } from '../../../components/MspConsole.client.js';

// See settings/page.tsx's own doc comment for why this independent,
// finer-grained role check exists alongside the (app) layout's own
// "is there a session at all" redirect — Next streams this segment
// independently of that layout.
export default async function MspPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  if (!roleAtLeast(user.role, 'admin')) {
    return (
      <ErrorState
        title="You don't have access to this page"
        description="Viewing linked clients requires the admin or owner role."
      />
    );
  }

  return <MspConsole />;
}
