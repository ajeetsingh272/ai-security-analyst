import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../../lib/session.js';
import { CaseList } from '../../../components/CaseList.client.js';

// Not redundant with the (app) layout's own redirect: Next streams route
// segments independently, so without this, curl (or anything that doesn't
// execute the client-side navigation a browser would) gets this page's
// real content in the SAME response as the layout's eventual redirect —
// confirmed by hand against a production build before adding this check.
// "Refused server-side" has to mean refused by every segment that could
// otherwise still produce real output, not just the nearest layout.
export default async function CasesPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  return <CaseList />;
}
