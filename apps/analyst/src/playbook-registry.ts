/**
 * The known playbook identifiers a Verdict's `recommendedActions` may
 * reference (P4-03 AC4). This is deliberately NOT the real playbook
 * registry — `planning/tickets/p5.json`'s own P5-05 ("Response playbook
 * registry and executor") owns that: per-playbook blast radius, required
 * scopes, step-up requirements, reversal procedures, and the actual
 * executor. Nothing here executes anything; this is only the validation
 * half P4-03 needs now, so a model-proposed action can be checked against
 * SOMETHING real rather than accepted as free text. The six identifiers
 * below are copied verbatim from P5-05's own ticket description, not
 * invented ahead of that design — when P5-05 ships its real registry,
 * this list should be replaced by (or generated from) it, not kept as a
 * second source of truth.
 */
export const PLAYBOOK_REGISTRY = [
  'disable_user',
  'revoke_sessions',
  'delete_inbox_rule',
  'block_ip',
  'force_password_reset',
  'isolate_device',
] as const;

export type PlaybookId = (typeof PLAYBOOK_REGISTRY)[number];

export function isKnownPlaybook(value: string): value is PlaybookId {
  return (PLAYBOOK_REGISTRY as readonly string[]).includes(value);
}
