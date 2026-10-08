'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, SeverityPill, Badge, Skeleton, EmptyState, ErrorState, Button } from '@sentinel/ui';
import type { CaseDetailResponse, CaseTransition, Claim, ActionRow, EvidenceResponse, EvidenceResult } from '../lib/case-detail.js';
import type { ChallengeDismissalResponse } from '../lib/dismissals.js';
import { FeedbackWidget } from './FeedbackWidget.client.js';

type LoadState = 'loading' | 'loaded' | 'error';

export interface CaseDetailProps {
  caseId: string;
}

export function CaseDetail({ caseId }: CaseDetailProps) {
  const [data, setData] = useState<CaseDetailResponse | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const res = await fetch(`/api/cases/${caseId}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`GET /cases/${caseId} failed: ${res.status}`);
      setData((await res.json()) as CaseDetailResponse);
      setLoadState('loaded');
    } catch {
      setLoadState('error');
    }
  }, [caseId]);

  useEffect(() => {
    void load();
  }, [load]);

  // P6-11: the page-level heading renders in every state — see
  // MspConsole.client.tsx's own doc comment for the gap this was
  // found to be a real, not just theoretical, instance of. The real
  // title is only known once loaded, so loading/error states get a
  // generic but still real heading rather than none at all.
  if (loadState === 'loading') {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="font-display text-display-m text-text-primary">Case</h1>
        <Skeleton lines={8} />
      </div>
    );
  }
  if (loadState === 'error') {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="font-display text-display-m text-text-primary">Case</h1>
        <ErrorState title="Could not load this case" onRetry={() => void load()} />
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center gap-3">
        {data.case.severity && <SeverityPill severity={data.case.severity} />}
        <h1 className="font-display text-display-m text-text-primary">{data.case.title ?? 'Untitled case'}</h1>
      </header>

      {data.transitions[0]?.toState === 'dismissed' && (
        <ChallengeDismissalSection caseId={caseId} transition={data.transitions[0]} onChallenged={() => void load()} />
      )}

      <FeedbackWidget subjectType="case" subjectId={caseId} />

      {data.verdict ? (
        <VerdictSection verdict={data.verdict} caseId={caseId} />
      ) : (
        <EmptyState title="No AI investigation yet" description="This case has not been through the analyst worker, or that result has not persisted a verdict." />
      )}

      {data.mitre.length > 0 && (
        <section aria-label="MITRE ATT&CK techniques" className="flex flex-col gap-3">
          <h2 className="font-ui text-body-m font-semibold text-text-primary">Techniques observed</h2>
          {data.mitre.map((m) => (
            <Card key={m.id}>
              <div className="flex items-center gap-2">
                <Badge variant="signal">{m.id}</Badge>
                <span className="font-ui text-body-s font-medium text-text-primary">{m.name}</span>
              </div>
              <p className="mt-2 text-body-s text-text-secondary">{m.description}</p>
            </Card>
          ))}
        </section>
      )}

      <ActionsSection caseId={caseId} actions={data.actions} onApproved={() => void load()} />

      <TimelineSection transitions={data.transitions} />
    </div>
  );
}

/** P6-08 (TG3: "Nothing is hidden — dismissals are surfaced") — AC3/T2:
 * challenging reopens the case via the real POST /cases/:id/challenge
 * (P3-07), which this file reuses rather than re-implementing. Visible
 * only while the case's own latest transition is still 'dismissed'. */
function ChallengeDismissalSection({ caseId, transition, onChallenged }: { caseId: string; transition: CaseTransition; onChallenged: () => void }) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function challenge() {
    if (reason.trim().length === 0) {
      setError('A reason is required to challenge a dismissal.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) {
        setError('Could not challenge this dismissal.');
        return;
      }
      (await res.json()) as ChallengeDismissalResponse;
      onChallenged();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="border-severity-high/30">
      <div className="flex flex-col gap-2">
        <p className="font-ui text-body-m font-medium text-text-primary">
          Dismissed by {transition.actorType === 'system' ? 'a rule' : transition.actorType === 'ai' ? "Sentinel's own AI" : transition.actorType}
        </p>
        <p className="text-body-s text-text-secondary">{transition.reason ?? 'no reason recorded'}</p>
        <div className="mt-1 flex items-center gap-2">
          <input
            type="text"
            aria-label="Reason for challenging this dismissal"
            placeholder="Why should this be reopened?"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="min-w-64 flex-1 rounded-md border border-border-hairline bg-surface-raised px-2 py-1.5 text-body-s text-text-primary"
          />
          <Button variant="primary" size="sm" isLoading={submitting} onClick={() => void challenge()}>
            Challenge dismissal
          </Button>
        </div>
        {error && (
          <span role="alert" className="text-body-s text-severity-critical">
            {error}
          </span>
        )}
      </div>
    </Card>
  );
}

function VerdictSection({ verdict, caseId }: { verdict: NonNullable<CaseDetailResponse['verdict']>; caseId: string }) {
  return (
    <section aria-label="Investigation report" className="flex flex-col gap-4">
      <h2 className="font-ui text-body-m font-semibold text-text-primary">{verdict.title}</h2>

      <div className="flex flex-col gap-2">
        {verdict.claims.map((claim, index) => (
          <ClaimRow key={index} claim={claim} caseId={caseId} />
        ))}
      </div>

      {verdict.attackChain.length > 0 && (
        <div>
          <h3 className="font-ui text-body-s font-semibold text-text-secondary">What happened, in order</h3>
          <ol className="mt-2 flex flex-col gap-1 pl-5 text-body-s text-text-secondary">
            {verdict.attackChain.map((step, i) => (
              <li key={i} className="list-decimal">
                {step}
              </li>
            ))}
          </ol>
        </div>
      )}

      {verdict.recommendedActions.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="font-ui text-body-s font-semibold text-text-secondary">Recommended</h3>
          {verdict.recommendedActions.map((action, i) => (
            <Card key={i}>
              <div className="flex items-center justify-between">
                <span className="font-ui text-body-s font-medium text-text-primary">{action.playbook}</span>
                <Badge variant="neutral">{action.urgency}</Badge>
              </div>
              <p className="mt-1 text-body-s text-text-secondary">{action.blastRadius}</p>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

function ClaimRow({ claim, caseId }: { claim: Claim; caseId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [evidence, setEvidence] = useState<EvidenceResult[] | null>(null);
  const [evidenceError, setEvidenceError] = useState(false);

  async function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && evidence === null && !evidenceError) {
      try {
        const res = await fetch(`/api/cases/${caseId}/evidence?ids=${claim.evidenceRef.join(',')}`, { cache: 'no-store' });
        if (!res.ok) {
          setEvidenceError(true);
          return;
        }
        const body = (await res.json()) as EvidenceResponse;
        setEvidence(body.results);
      } catch {
        setEvidenceError(true);
      }
    }
  }

  return (
    <Card onClick={toggle} aria-expanded={expanded}>
      <p className="font-ui text-body-m text-text-primary">{claim.text}</p>
      {expanded && (
        <div className="mt-3 flex flex-col gap-2 border-t border-border-hairline pt-3" aria-label="Evidence for this claim">
          {evidenceError && <p className="text-body-s text-severity-critical">Evidence could not be checked right now.</p>}
          {evidence === null && !evidenceError && <Skeleton lines={2} />}
          {evidence?.map((e) => <EvidenceRow key={e.id} result={e} />)}
        </div>
      )}
    </Card>
  );
}

function EvidenceRow({ result }: { result: EvidenceResult }) {
  if (result.status === 'found') {
    return (
      <div className="rounded-md bg-surface-sunken p-2 font-mono text-mono-s text-text-secondary" role="status">
        <span className="text-verified">verified</span> — {result.event.message ?? result.event.event_id} ({result.event.time})
      </div>
    );
  }
  if (result.status === 'pending') {
    return (
      <div className="rounded-md bg-surface-sunken p-2 text-body-s text-text-tertiary" role="status">
        Still indexing this event — check back shortly.
      </div>
    );
  }
  return (
    <div className="rounded-md bg-surface-sunken p-2 text-body-s text-text-tertiary" role="status">
      This event id could not be found.
    </div>
  );
}

function ActionsSection({ caseId, actions, onApproved }: { caseId: string; actions: ActionRow[]; onApproved: () => void }) {
  if (actions.length === 0) {
    return (
      <EmptyState
        title="No proposed actions yet for this case"
        description="A recommended action above becomes approvable here once it has actually been proposed — that step does not happen automatically for every case yet."
      />
    );
  }

  return (
    <section aria-label="Proposed actions" className="flex flex-col gap-3">
      <h2 className="font-ui text-body-m font-semibold text-text-primary">Actions</h2>
      {actions.map((action) => (
        <ActionRowCard key={action.id} caseId={caseId} action={action} onApproved={onApproved} />
      ))}
    </section>
  );
}

function ActionRowCard({ caseId, action, onApproved }: { caseId: string; action: ActionRow; onApproved: () => void }) {
  const [needsStepUp, setNeedsStepUp] = useState(false);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve(stepUpPassword?: string) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/actions/${action.id}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(stepUpPassword ? { stepUpPassword } : {}),
      });
      if (res.status === 401) {
        setNeedsStepUp(true);
        return;
      }
      if (!res.ok) {
        setError('Could not approve this action.');
        return;
      }
      onApproved();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="font-ui text-body-s font-medium text-text-primary">{action.playbook}</p>
          <p className="text-body-s text-text-secondary">{action.blastRadius}</p>
        </div>
        <Badge variant="neutral">{action.status}</Badge>
      </div>

      {action.status === 'proposed' && (
        <div className="mt-3 flex items-center gap-2 border-t border-border-hairline pt-3">
          {needsStepUp && (
            <input
              type="password"
              aria-label="Step-up password"
              placeholder="Confirm your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-md border border-border-hairline bg-surface-raised px-2 py-1.5 text-body-s text-text-primary"
            />
          )}
          <Button variant="primary" size="sm" isLoading={submitting} onClick={() => void approve(needsStepUp ? password : undefined)}>
            Approve
          </Button>
          {error && (
            <span role="alert" className="text-body-s text-severity-critical">
              {error}
            </span>
          )}
        </div>
      )}
    </Card>
  );
}

function TimelineSection({ transitions }: { transitions: CaseDetailResponse['transitions'] }) {
  if (transitions.length === 0) return null;
  const chronological = [...transitions].reverse();

  return (
    <section aria-label="Case history" className="flex flex-col gap-2">
      <h2 className="font-ui text-body-m font-semibold text-text-primary">History</h2>
      <ol className="flex flex-col gap-2">
        {chronological.map((t, i) => (
          <li key={i} className="flex items-center gap-3 text-body-s text-text-secondary">
            <Badge variant="neutral">{t.toState}</Badge>
            <span>{t.reason ?? 'no reason recorded'}</span>
            <span className="text-text-tertiary">— {new Date(t.occurredAt).toLocaleString()}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
