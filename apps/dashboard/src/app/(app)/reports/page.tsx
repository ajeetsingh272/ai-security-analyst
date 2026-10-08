import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../../lib/session.js';
import { roleAtLeast } from '../../../lib/nav-items.js';
import { WeeklyReportView } from '../../../components/WeeklyReportView.client.js';

// See cases/page.tsx's doc comment: Next streams this segment
// independently of the (app) layout's own redirect, so this page must
// refuse to render on its own too, not rely on the layout alone.
export default async function ReportsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  return <WeeklyReportView canManage={roleAtLeast(user.role, 'admin')} />;
}
