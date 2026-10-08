import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../../../../lib/session.js';
import { ScanReport } from '../../../../../components/ScanReport.client.js';

// See cases/page.tsx's own doc comment: this independent check is
// required, not redundant with the (app) layout's own redirect.
export default async function ScanReportPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  const { id } = await params;
  return <ScanReport scanId={id} />;
}
