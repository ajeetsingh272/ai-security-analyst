import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { Skeleton } from '@sentinel/ui';
import { getCurrentUser } from '../../../lib/session.js';
import { ConnectorsWizard } from '../../../components/ConnectorsWizard.client.js';

// See cases/page.tsx's doc comment: Next streams this segment
// independently of the (app) layout's own redirect, so this page must
// refuse to render on its own too, not rely on the layout alone.
export default async function ConnectorsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  // ConnectorsWizard reads the OAuth callback's own ?m365=/&reason=
  // query params via useSearchParams(), which Next requires a Suspense
  // boundary around.
  return (
    <Suspense fallback={<Skeleton lines={6} />}>
      <ConnectorsWizard />
    </Suspense>
  );
}
