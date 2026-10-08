import { redirect } from 'next/navigation';
import { EmptyState } from '@sentinel/ui';
import { getCurrentUser } from '../../../lib/session.js';

// See cases/page.tsx's doc comment: Next streams this segment
// independently of the (app) layout's own redirect, so this page must
// refuse to render on its own too, not rely on the layout alone.
export default async function ConnectorsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  return (
    <EmptyState
      title="Connector management is coming in P6-04"
      description="The onboarding wizard and connection health view land next."
    />
  );
}
