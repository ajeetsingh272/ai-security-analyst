import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../../../lib/session.js';
import { CaseDetail } from '../../../../components/CaseDetail.client.js';

// See ../page.tsx's own doc comment: this independent check is required,
// not redundant with the (app) layout's own redirect — Next streams this
// segment on its own.
export default async function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  const { id } = await params;
  return <CaseDetail caseId={id} />;
}
