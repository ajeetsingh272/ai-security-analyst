/**
 * P5-05: the six response playbooks (promoted from
 * apps/analyst/src/playbook-registry.ts's own deliberately-minimal
 * validation-only list — that file's own doc comment says this
 * package is what should replace it as the single source of truth).
 */
export type PlaybookId = 'disable_user' | 'revoke_sessions' | 'delete_inbox_rule' | 'block_ip' | 'force_password_reset' | 'isolate_device';

export const ALL_PLAYBOOK_IDS: readonly PlaybookId[] = ['disable_user', 'revoke_sessions', 'delete_inbox_rule', 'block_ip', 'force_password_reset', 'isolate_device'];

export function isKnownPlaybook(id: string): id is PlaybookId {
  return (ALL_PLAYBOOK_IDS as readonly string[]).includes(id);
}

/**
 * A minimal HTTP seam over Microsoft Graph — `FetchGraphClient`
 * (graph-client.ts) is the real implementation; every playbook's own
 * unit test uses a fake, the same "test double over a real HTTP call"
 * discipline WhatsAppChannel's own tests already established.
 */
export interface GraphResponse {
  status: number;
  body: unknown;
}

export interface GraphClient {
  get(path: string): Promise<GraphResponse>;
  patch(path: string, body: unknown): Promise<GraphResponse>;
  post(path: string, body?: unknown): Promise<GraphResponse>;
  delete(path: string): Promise<GraphResponse>;
}

/** Each playbook's own target shape is a plain record — validated by
 * that playbook itself (`validatePremise`), never by the executor. */
export type PlaybookTarget = Record<string, unknown>;

export type PremiseCheckResult = { ok: true } | { ok: false; reason: string };

export type ExecutionOutcome =
  | { ok: true }
  /** AC4/T4: "a recorded, recoverable state with explicit manual
   * steps" — `recoverable: true` means a human can finish this by
   * hand right now (e.g. no integration exists yet for this action at
   * all); `recoverable: false` means the failure is unexpected and
   * needs investigation before anyone acts on `manualSteps`. */
  | { ok: false; recoverable: boolean; manualSteps: string; error: string };

export interface Playbook {
  readonly id: PlaybookId;
  /** Plain-English description of what this touches if it runs —
   * shown to the approver before they tap Approve (report.ts's own
   * PLAYBOOK_PLAIN map is the TS-side precedent for this same text;
   * P5-05 is the "single source of truth" that map's own comment asks
   * for, so this field's values are copied from there verbatim). */
  readonly blastRadius: string;
  readonly requiredScopes: readonly string[];
  readonly requiresStepUp: boolean;
  /** AC1/T5: every registered playbook must declare how a human
   * reverses it — enforced by registry.test.ts over every entry, not
   * trusted per-file. */
  readonly reversalProcedure: string;
  /** AC3/T3: "confirms the target still matches the case's premise" —
   * must run, and must pass, before `execute` is ever called. */
  validatePremise(graph: GraphClient, target: PlaybookTarget): Promise<PremiseCheckResult>;
  /** AC2/T2: idempotent — already-applied state is detected and
   * treated as success, never re-applied as a second side effect. */
  execute(graph: GraphClient, target: PlaybookTarget): Promise<ExecutionOutcome>;
}
