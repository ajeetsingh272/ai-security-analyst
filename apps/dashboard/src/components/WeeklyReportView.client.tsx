'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, Skeleton, EmptyState, ErrorState, Button } from '@sentinel/ui';
import { DAY_NAMES, type WeeklyReportListResponse, type ReportSchedule, type WeeklyReportRow } from '../lib/weekly-report.js';

type LoadState = 'loading' | 'loaded' | 'error';

export interface WeeklyReportViewProps {
  /** AC3/role-gating: "generate now" and the schedule setting are
   * admin-only actions within an otherwise read_only-visible page — see
   * this file's own tests for why the schedule section isn't fetched
   * at all for a read_only viewer (GET /reports/schedule is itself
   * admin-gated, not read_only). */
  canManage: boolean;
}

function ReportCard({ report }: { report: WeeklyReportRow }) {
  return (
    <Card className={report.isQuiet ? 'border-verified/30 bg-verified/10' : 'border-severity-high/30'}>
      <div className="flex flex-col gap-2">
        <p className="font-ui text-body-s text-text-tertiary">
          {new Date(report.windowStart).toLocaleDateString()} – {new Date(report.windowEnd).toLocaleDateString()}
        </p>
        <p className="font-ui text-body-m font-medium text-text-primary">{report.headline}</p>
        {report.oneImprovement && (
          <p className="font-ui text-body-s text-text-secondary">One thing to improve: {report.oneImprovement}</p>
        )}
        <div>
          <a
            href={`/api/reports/weekly/${report.id}/pdf`}
            download
            className="font-ui text-body-s font-medium text-accent-primary underline"
          >
            Download PDF
          </a>
        </div>
      </div>
    </Card>
  );
}

export function WeeklyReportView({ canManage }: WeeklyReportViewProps) {
  const [data, setData] = useState<WeeklyReportListResponse | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [generateState, setGenerateState] = useState<'idle' | 'generating'>('idle');

  const [schedule, setSchedule] = useState<ReportSchedule | null>(null);
  const [scheduleLoadState, setScheduleLoadState] = useState<LoadState>('loading');
  const [savingSchedule, setSavingSchedule] = useState(false);

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const res = await fetch('/api/reports/weekly', { cache: 'no-store' });
      if (!res.ok) throw new Error(`GET /reports/weekly failed: ${res.status}`);
      setData((await res.json()) as WeeklyReportListResponse);
      setLoadState('loaded');
    } catch {
      setLoadState('error');
    }
  }, []);

  const loadSchedule = useCallback(async () => {
    setScheduleLoadState('loading');
    try {
      const res = await fetch('/api/reports/schedule', { cache: 'no-store' });
      if (!res.ok) throw new Error(`GET /reports/schedule failed: ${res.status}`);
      setSchedule((await res.json()) as ReportSchedule);
      setScheduleLoadState('loaded');
    } catch {
      setScheduleLoadState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (canManage) void loadSchedule();
  }, [canManage, loadSchedule]);

  async function generateNow() {
    setGenerateState('generating');
    try {
      const res = await fetch('/api/reports/weekly', { method: 'POST' });
      if (res.ok) await load();
    } finally {
      setGenerateState('idle');
    }
  }

  async function updateSchedule(patch: Partial<ReportSchedule>) {
    // Optimistic: `schedule.enabled`/`dayOfWeek` drive a CONTROLLED
    // input/select — without updating this before the request resolves,
    // React re-renders with the still-stale value on the very next tick
    // and the control visibly snaps back until the PATCH completes.
    const previous = schedule;
    setSchedule((current) => (current ? { ...current, ...patch } : current));
    setSavingSchedule(true);
    try {
      const res = await fetch('/api/reports/schedule', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        setSchedule((await res.json()) as ReportSchedule);
      } else {
        setSchedule(previous);
      }
    } catch {
      setSchedule(previous);
    } finally {
      setSavingSchedule(false);
    }
  }

  if (loadState === 'loading') return <Skeleton lines={6} />;
  if (loadState === 'error') return <ErrorState title="Could not load reports" onRetry={() => void load()} />;
  if (!data) return null;

  const [latest, ...older] = data.reports;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="font-display text-display-m text-text-primary">Weekly reports</h1>
        {canManage && (
          <Button variant="secondary" onClick={() => void generateNow()} disabled={generateState === 'generating'}>
            {generateState === 'generating' ? 'Generating…' : 'Generate now'}
          </Button>
        )}
      </header>

      {!latest ? (
        <EmptyState
          title="No reports yet"
          description={
            canManage
              ? 'Generate your first weekly report now, or wait for the next scheduled run.'
              : 'Your weekly summary will appear here once Sentinel generates the first one.'
          }
        />
      ) : (
        <ReportCard report={latest} />
      )}

      {older.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="font-ui text-body-s font-medium text-text-secondary">Previous reports</h2>
          <ul className="flex flex-col gap-2" aria-label="Previous weekly reports">
            {older.map((report) => (
              <li key={report.id}>
                <ReportCard report={report} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {canManage && (
        <section className="flex flex-col gap-3">
          <h2 className="font-ui text-body-s font-medium text-text-secondary">Schedule</h2>
          {scheduleLoadState === 'loading' && <Skeleton lines={2} />}
          {scheduleLoadState === 'error' && (
            <ErrorState title="Could not load the schedule" onRetry={() => void loadSchedule()} />
          )}
          {scheduleLoadState === 'loaded' && schedule && (
            <Card>
              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-1">
                  <span className="font-ui text-body-s font-medium text-text-secondary">Day of week</span>
                  <select
                    value={schedule.dayOfWeek}
                    disabled={savingSchedule}
                    onChange={(e) => void updateSchedule({ dayOfWeek: Number(e.target.value) })}
                    className="rounded-md border border-border-hairline bg-surface-raised px-3 py-2 text-body-m text-text-primary"
                  >
                    {DAY_NAMES.map((name, index) => (
                      <option key={name} value={index}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={schedule.enabled}
                    disabled={savingSchedule}
                    onChange={(e) => void updateSchedule({ enabled: e.target.checked })}
                  />
                  <span className="font-ui text-body-s text-text-primary">Send the weekly report automatically</span>
                </label>
              </div>
            </Card>
          )}
        </section>
      )}
    </div>
  );
}
