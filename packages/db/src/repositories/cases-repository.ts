/**
 * The reference implementation of `TenantScopedRepository`.
 *
 * Exists partly to be useful and partly to prove the pattern compiles and
 * runs end to end — P0-05's acceptance criteria are about the base class's
 * behaviour, and the clearest way to show it holds is a repository that
 * actually queries a real table.
 *
 * P3-07 (TG3: "nothing is hidden — dismissals are surfaced") added
 * `dailyDismissalDigest` and `challengeDismissal` — the one place this
 * package writes `case_transitions` from TypeScript, mirroring
 * `services/correlate/internal/lifecycle.Writer`'s own Go-side writer
 * for the identical `dismissed → triaging` edge (a human challenging an
 * auto-dismissal is naturally an API-initiated action, the same way
 * `SuppressionsRepository.revoke` already is for suppressions). The two
 * writers are NOT the same code — Go's own `IsLegalTransition` is not
 * re-implemented here in full; `challengeDismissal` only ever checks the
 * ONE specific precondition it needs (the case is currently dismissed),
 * which is also the only transition this class is ever asked to write.
 */
import { TenantScopedRepository } from '../tenant-context.js';
import { writeAuditEntryTx } from '../audit/audit-log-writer.js';

export interface CaseRow {
  id: string;
  tenantId: string;
  severity: string | null;
  title: string | null;
  signalCount: number;
  createdAt: string;
  windowStart: string;
  windowEnd: string | null;
}

export interface CaseSignalRow {
  signalId: string;
  ruleId: string;
  entityType: string;
  entityId: string;
  severity: string;
  detectedAt: string;
  /** P6-03: the case detail screen's own "MITRE technique, plain-
   * English explanation" panel reads this per signal. */
  mitreIds: string[];
}

export interface CaseTransitionRow {
  fromState: string;
  toState: string;
  actorType: string;
  actorId: string;
  reason: string | null;
  occurredAt: string;
}

export interface CaseHistory {
  case: CaseRow | null;
  signals: CaseSignalRow[];
  transitions: CaseTransitionRow[];
}

/** P6-02's own list row — deliberately a separate type from `CaseRow`
 * rather than widening it: `CaseRow` is used by call sites (dismissals.ts)
 * that have no business depending on `state`/`score`/`entityIds` just
 * because this ticket added them somewhere else in the same file. */
export interface CaseListItem {
  id: string;
  tenantId: string;
  severity: string | null;
  title: string | null;
  score: number | null;
  /** Derived from the latest case_transitions row, same as
   * `currentState()` — every case gets an initial 'open' transition at
   * creation (services/correlate's own lifecycle.Writer), so this is
   * never actually null in practice, but the column it comes from can be,
   * and this type says so rather than asserting it away. */
  state: string | null;
  entityIds: string[];
  signalCount: number;
  createdAt: string;
  windowStart: string;
  windowEnd: string | null;
}

export interface CaseListFilters {
  severity?: string | undefined;
  state?: string | undefined;
  entityId?: string | undefined;
  ruleId?: string | undefined;
  createdAfter?: string | undefined;
  createdBefore?: string | undefined;
}

export interface CaseListPage {
  items: CaseListItem[];
  total: number;
}

export interface FilterOption {
  value: string;
  label: string;
}

export interface CaseFilterOptions {
  entities: FilterOption[];
  rules: FilterOption[];
}

/** `pg` parses a `timestamptz` column into a real JS `Date`, regardless
 * of what a query's own TS generic claims its type is — `String(date)`
 * then calls `Date.prototype.toString()` (a locale-formatted, not ISO,
 * string: "Thu Oct 08 2026 13:08:11 GMT+0530 ..."), not `.toISOString()`.
 * `mapRow` above has this same latent bug (pre-existing, out of this
 * ticket's scope — nothing exposed its output through a real JSON API
 * before `list()` did), but `mapListRow` is new in this ticket and feeds
 * a real browser via `GET /cases`, so it gets the correct conversion.
 * Handles either a `Date` or an already-string value, since which one a
 * given query path returns isn't guaranteed by the type annotations
 * alone. */
function toIsoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function mapListRow(row: Record<string, unknown>): CaseListItem {
  return {
    id: String(row['id']),
    tenantId: String(row['tenant_id']),
    severity: (row['severity'] as string | null) ?? null,
    title: (row['title'] as string | null) ?? null,
    score: row['score'] == null ? null : Number(row['score']),
    state: (row['state'] as string | null) ?? null,
    entityIds: (row['entity_ids'] as string[] | null) ?? [],
    signalCount: Number(row['signal_count']),
    createdAt: toIsoString(row['created_at']),
    windowStart: toIsoString(row['window_start']),
    windowEnd: row['window_end'] == null ? null : toIsoString(row['window_end']),
  };
}

export interface DismissalDigestRow {
  /** 'system' for a rule-based dismissal (services/correlate/internal/
   * lifecycle's own writer), 'ai' for a triage dismissal (P4-05's
   * worker.ts) — P4-12 AC3's own "distinguishes rule-based from
   * AI-based dismissals." */
  actorType: string;
  /** For 'system': machine-readable (services/correlate/internal/
   * lifecycle.DismissalReason), e.g. "below_escalation_threshold". For
   * 'ai': the model's own stated reason (P4-12 AC1) — free prose, so
   * two AI dismissals only group together when their stated reasons
   * happen to match exactly; that is the correct behaviour, not a
   * limitation to work around with clustering this ticket never asked
   * for. */
  reason: string;
  caseCount: number;
  signalCount: number;
}

export class DismissalChallengeEmptyReasonError extends Error {
  constructor() {
    super('A reason is required to challenge a dismissal and cannot be blank.');
    this.name = 'DismissalChallengeEmptyReasonError';
  }
}

/** P4-12 T3: "a dismissal recorded without a reason fails validation." */
export class AiDismissalEmptyReasonError extends Error {
  constructor() {
    super('An AI dismissal requires the model\'s own stated reason and cannot be blank.');
    this.name = 'AiDismissalEmptyReasonError';
  }
}

function mapRow(row: Record<string, unknown>): CaseRow {
  return {
    id: String(row['id']),
    tenantId: String(row['tenant_id']),
    severity: (row['severity'] as string | null) ?? null,
    title: (row['title'] as string | null) ?? null,
    signalCount: Number(row['signal_count']),
    createdAt: String(row['created_at']),
    windowStart: String(row['window_start']),
    windowEnd: (row['window_end'] as string | null) ?? null,
  };
}

export class CasesRepository extends TenantScopedRepository {
  /**
   * Deliberately has NO `WHERE tenant_id = ...` clause. That omission is the
   * point of this method: the query relies entirely on the RLS policy set up
   * by `withTransaction`'s `SET LOCAL app.tenant_id`, which is exactly
   * P0-05 T2 — "a query deliberately written without a tenant_id filter still
   * returns only the current tenant's rows." If this method ever starts
   * returning another tenant's cases, the bug is in the database layer, not
   * a missing filter here — which is precisely the property RLS exists to
   * guarantee.
   */
  async findAll(): Promise<CaseRow[]> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        'SELECT id, tenant_id, severity, title, signal_count, created_at, window_start, window_end FROM cases ORDER BY created_at DESC',
      );
      return rows.map(mapRow);
    });
  }

  /**
   * P6-02: the dashboard's case list — filtered by severity, current
   * state, entity, rule and/or a creation date range; ranked by severity
   * then score (the same CASE expression 0023's own index mirrors, so the
   * planner can actually use it instead of a sequential scan + sort at
   * the ticket's stated 10,000-case scale).
   *
   * `state` has no column of its own on `cases` (see `currentState()`'s
   * own comment) — the LATERAL join below is the one extra cost a plain
   * `WHERE` can't avoid, but `case_transitions_case_idx (case_id, id)`
   * keeps "the single latest row per case" an index lookup, not a scan,
   * for every row this query otherwise considers.
   */
  async list(filters: CaseListFilters, page: number, pageSize: number): Promise<CaseListPage> {
    return this.withTransaction(async (client) => {
      const conditions: string[] = [];
      const params: unknown[] = [];

      function addCondition(sqlFragment: string, value: unknown): void {
        params.push(value);
        conditions.push(sqlFragment.replace('$$', `$${params.length}`));
      }

      if (filters.severity) addCondition('c.severity = $$', filters.severity);
      if (filters.entityId) addCondition('c.entity_ids @> ARRAY[$$]::text[]', filters.entityId);
      if (filters.createdAfter) addCondition('c.created_at >= $$', filters.createdAfter);
      if (filters.createdBefore) addCondition('c.created_at <= $$', filters.createdBefore);
      if (filters.ruleId) {
        addCondition('EXISTS (SELECT 1 FROM case_signals cs WHERE cs.case_id = c.id AND cs.rule_id = $$)', filters.ruleId);
      }
      if (filters.state) {
        addCondition('ct.to_state = $$', filters.state);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const baseFrom = `
        FROM cases c
        JOIN LATERAL (
          SELECT to_state FROM case_transitions WHERE case_id = c.id ORDER BY id DESC LIMIT 1
        ) ct ON true
        ${whereClause}`;

      const countResult = await client.query<{ total: string }>(`SELECT count(*) AS total ${baseFrom}`, params);
      const total = Number(countResult.rows[0]?.total ?? 0);

      const limitParamIndex = params.length + 1;
      const offsetParamIndex = params.length + 2;
      const { rows } = await client.query(
        `SELECT c.id, c.tenant_id, c.severity, c.title, c.score, c.signal_count, c.created_at,
                c.window_start, c.window_end, c.entity_ids, ct.to_state AS state
         ${baseFrom}
         ORDER BY
           (CASE c.severity
             WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0
           END) DESC,
           c.score DESC NULLS LAST,
           c.created_at DESC
         LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}`,
        [...params, pageSize, (page - 1) * pageSize],
      );

      return { items: rows.map(mapListRow), total };
    });
  }

  /**
   * Filter dropdown data for the case list. There is no rules CATALOG
   * table anywhere in this schema (per-signal `rule_id` is a free-text
   * column on `case_signals`, not a foreign key into a lookup table), so
   * a rule's own id IS its label here — an honest limitation, not a
   * placeholder silently treated as more. Entities at least have
   * human-readable aliases (email, username, ...) to use as a label when
   * one exists.
   */
  async filterOptions(): Promise<CaseFilterOptions> {
    return this.withTransaction(async (client) => {
      const entityResult = await client.query<{ id: string; entity_type: string; label: string | null }>(
        `SELECT e.id, e.entity_type,
                (SELECT alias_value FROM entity_aliases WHERE entity_id = e.id ORDER BY created_at ASC LIMIT 1) AS label
           FROM entities e
          WHERE e.id IN (
            SELECT DISTINCT val::uuid FROM (SELECT unnest(entity_ids) AS val FROM cases) t WHERE val <> ''
          )
          ORDER BY label NULLS LAST
          LIMIT 200`,
      );
      const ruleResult = await client.query<{ rule_id: string }>(
        `SELECT DISTINCT rule_id FROM case_signals ORDER BY rule_id LIMIT 200`,
      );

      return {
        entities: entityResult.rows.map((r) => ({ value: r.id, label: r.label ?? `${r.entity_type}:${r.id}` })),
        rules: ruleResult.rows.map((r) => ({ value: r.rule_id, label: r.rule_id })),
      };
    });
  }

  async findById(id: string): Promise<CaseRow | null> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        'SELECT id, tenant_id, severity, title, signal_count, created_at, window_start, window_end FROM cases WHERE id = $1',
        [id],
      );
      return rows.length > 0 ? mapRow(rows[0]) : null;
    });
  }

  /**
   * AC2: "a daily digest per tenant lists dismissals grouped by reason."
   * `cases.signal_count` is already maintained by
   * services/correlate/internal/cluster (incremented as each signal
   * joins), so summing it per reason gives the TOTAL underlying signal
   * volume each reason accounts for, not just a count of cases — "every
   * non-escalated SIGNAL" (AC1's own wording), not only every dismissed
   * case.
   */
  async dailyDismissalDigest(day: Date): Promise<DismissalDigestRow[]> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query<{ actor_type: string; reason: string; case_count: string; signal_count: string }>(
        `SELECT ct.actor_type, ct.reason, count(DISTINCT ct.case_id) AS case_count, sum(c.signal_count) AS signal_count
           FROM case_transitions ct
           JOIN cases c ON c.id = ct.case_id
          WHERE ct.to_state = 'dismissed'
            AND ct.occurred_at >= $1
            AND ct.occurred_at < $1::timestamptz + INTERVAL '1 day'
          GROUP BY ct.actor_type, ct.reason
          ORDER BY case_count DESC`,
        [day.toISOString()],
      );
      return rows.map((r) => ({
        actorType: r.actor_type,
        reason: r.reason,
        caseCount: Number(r.case_count),
        signalCount: Number(r.signal_count),
      }));
    });
  }

  /**
   * P4-12 AC1: "every AI dismissal records the model's stated reason."
   * Mirrors `challengeDismissal`'s own shape (read the current state,
   * write one transition) but for the OPPOSITE edge — triaging (or
   * whatever state the case was already in) to dismissed, with
   * `actor_type = 'ai'` so `dailyDismissalDigest` can tell it apart
   * from a rule-based dismissal (AC3). Called from `worker.ts`'s own
   * triage step the moment a case is dismissed, never from inside the
   * model itself — the model only ever RETURNS a reason string; this
   * repository is what turns that into a durable, auditable fact.
   */
  async recordAiDismissal(caseId: string, reason: string): Promise<void> {
    if (reason.trim().length === 0) {
      throw new AiDismissalEmptyReasonError();
    }
    await this.withTransaction(async (client) => {
      const current = await client.query<{ to_state: string | null }>(
        'SELECT to_state FROM case_transitions WHERE case_id = $1 ORDER BY id DESC LIMIT 1',
        [caseId],
      );
      await client.query(
        `INSERT INTO case_transitions (tenant_id, case_id, from_state, to_state, actor_type, actor_id, reason)
         VALUES ($1, $2, $3, 'dismissed', 'ai', 'sentinel-analyst', $4)`,
        [this.tenantId, caseId, current.rows[0]?.to_state ?? null, reason],
      );
    });
  }

  /**
   * P5-05 AC4/T4: "partial failure returns the case to
   * awaiting_approval" — a playbook execution that fails partway
   * writes this transition so a human sees the case needs their
   * attention again, rather than it silently sitting wherever its
   * last successful state happened to be. Mirrors recordAiDismissal's
   * own "read current to_state, write one transition" shape.
   */
  async returnToAwaitingApproval(caseId: string, reason: string): Promise<void> {
    await this.withTransaction(async (client) => {
      const current = await client.query<{ to_state: string | null }>(
        'SELECT to_state FROM case_transitions WHERE case_id = $1 ORDER BY id DESC LIMIT 1',
        [caseId],
      );
      await client.query(
        `INSERT INTO case_transitions (tenant_id, case_id, from_state, to_state, actor_type, actor_id, reason)
         VALUES ($1, $2, $3, 'awaiting_approval', 'system', 'sentinel-response', $4)`,
        [this.tenantId, caseId, current.rows[0]?.to_state ?? null, reason],
      );
    });
  }

  /** The current to_state of a case, derived the same way
   * services/correlate/internal/lifecycle.CurrentState is: the most
   * recently written case_transitions row, nothing stored
   * destructively. Returns null for a case with no transitions at all
   * (should not happen for a real case, but this is a read, not an
   * assumption). */
  async currentState(caseId: string): Promise<string | null> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query<{ to_state: string }>(
        'SELECT to_state FROM case_transitions WHERE case_id = $1 ORDER BY id DESC LIMIT 1',
        [caseId],
      );
      return rows[0]?.to_state ?? null;
    });
  }

  /**
   * get_case_history (P4-02 AC1): a case's full signal and transition
   * history, newest first. `limit` is fetched as `limit + 1` so the
   * caller (apps/analyst's own tool wrapper) can tell "there were exactly
   * `limit` rows" apart from "there were more than `limit` rows" without a
   * separate COUNT query — the same bounded-plus-one shape
   * `findById`/`findAll` don't need but a tool with an explicit
   * truncation marker (AC3) does.
   */
  async history(caseId: string, limit: number): Promise<CaseHistory> {
    return this.withTransaction(async (client) => {
      const caseResult = await client.query(
        'SELECT id, tenant_id, severity, title, signal_count, created_at, window_start, window_end FROM cases WHERE id = $1',
        [caseId],
      );
      const signalResult = await client.query<{
        signal_id: string;
        rule_id: string;
        entity_type: string;
        entity_id: string;
        severity: string;
        detected_at: string;
        mitre_ids: string[] | null;
      }>(
        `SELECT signal_id, rule_id, entity_type, entity_id, severity, detected_at, mitre_ids
           FROM case_signals WHERE case_id = $1 ORDER BY detected_at DESC LIMIT $2`,
        [caseId, limit + 1],
      );
      const transitionResult = await client.query<{
        from_state: string;
        to_state: string;
        actor_type: string;
        actor_id: string;
        reason: string | null;
        occurred_at: string;
      }>(
        `SELECT from_state, to_state, actor_type, actor_id, reason, occurred_at
           FROM case_transitions WHERE case_id = $1 ORDER BY id DESC LIMIT $2`,
        [caseId, limit + 1],
      );
      return {
        case: caseResult.rows.length > 0 ? mapRow(caseResult.rows[0]) : null,
        signals: signalResult.rows.map((r) => ({
          signalId: r.signal_id,
          ruleId: r.rule_id,
          entityType: r.entity_type,
          entityId: r.entity_id,
          severity: r.severity,
          detectedAt: r.detected_at,
          // The column's own default is `['']`, for a row written
          // before P6-03 ever cared about this field — filtered out
          // rather than surfaced as a fake empty "technique."
          mitreIds: (r.mitre_ids ?? []).filter((id) => id.length > 0),
        })),
        transitions: transitionResult.rows.map((r) => ({
          fromState: r.from_state,
          toState: r.to_state,
          actorType: r.actor_type,
          actorId: r.actor_id,
          reason: r.reason,
          occurredAt: r.occurred_at,
        })),
      };
    });
  }

  /**
   * AC5: "a dismissal can be challenged, which reopens the case and is
   * audited." Returns null if the case is not currently dismissed —
   * there is nothing to challenge, not an error (a caller re-submitting
   * an already-handled challenge, or racing another analyst, should see
   * "not found" semantics, not a 500).
   *
   * Writes case_transitions and the audit entry in the SAME transaction
   * (the identical AC5 guarantee services/correlate/internal/lifecycle's
   * own Go writer gives P3-03's transitions) — `writeAuditEntryTx` is
   * exactly the function `AuditLogWriter.insert` itself calls, just with
   * this method's own already-open client instead of a fresh one.
   */
  async challengeDismissal(caseId: string, actorId: string, reason: string): Promise<CaseRow | null> {
    if (reason.trim().length === 0) {
      throw new DismissalChallengeEmptyReasonError();
    }
    return this.withTransaction(async (client) => {
      const current = await client.query<{ to_state: string }>(
        'SELECT to_state FROM case_transitions WHERE case_id = $1 ORDER BY id DESC LIMIT 1',
        [caseId],
      );
      if (current.rows[0]?.to_state !== 'dismissed') {
        return null;
      }

      await client.query(
        `INSERT INTO case_transitions (tenant_id, case_id, from_state, to_state, actor_type, actor_id, reason)
         VALUES ($1, $2, 'dismissed', 'triaging', 'human', $3, $4)`,
        [this.tenantId, caseId, actorId, reason],
      );
      await writeAuditEntryTx(client, this.tenantId, {
        actorType: 'human',
        actorId,
        action: 'case.transition',
        subjectType: 'case',
        subjectId: caseId,
        payload: { fromState: 'dismissed', toState: 'triaging', reason },
      });

      const { rows } = await client.query(
        'SELECT id, tenant_id, severity, title, signal_count, created_at, window_start, window_end FROM cases WHERE id = $1',
        [caseId],
      );
      return rows.length > 0 ? mapRow(rows[0]) : null;
    });
  }
}
