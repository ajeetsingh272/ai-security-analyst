import { redirect } from 'next/navigation';
import { EmptyState } from '@sentinel/ui';
import { getCurrentUser } from '../../../lib/session.js';

// See cases/page.tsx's doc comment: Next streams this segment
// independently of the (app) layout's own redirect, so this page must
// refuse to render on its own too, not rely on the layout alone.
export default async function ReportsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  return (
    <EmptyState
      title="Weekly reports are coming in P6-07"
      description="The one-page owner summary and PDF export land next."
    />
  );
}
