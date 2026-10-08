import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../../lib/session.js';
import { DismissalDigest } from '../../../components/DismissalDigest.client.js';

// See cases/page.tsx's doc comment: Next streams this segment
// independently of the (app) layout's own redirect, so this page must
// refuse to render on its own too, not rely on the layout alone.
export default async function DismissalsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  return <DismissalDigest />;
}
