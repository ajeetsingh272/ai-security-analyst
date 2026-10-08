# Runbook: response action fails

**Failure row:** `docs/architecture/overview.md` §6 — "Response action fails | Case returns
to `awaiting_approval`, error surfaced with manual steps | Never silently 'fixed'."

**Guarantee at risk:** the product's own core promise that a case is either genuinely fixed
or visibly still open — never quietly marked done while the underlying problem (a
compromised account, a malicious inbox rule) remains. `ActionsRepository.markFailed` +
`CasesRepository.returnToAwaitingApproval` (P5-05/P5-09) are what enforce this: a failed
action's own row carries the real error and the exact manual steps an operator needs, and
the case itself moves back to `awaiting_approval` so a human sees it needs attention again,
rather than it sitting wherever its last successful state happened to be.

## What this means

An approved action (`disable_user`, `revoke_sessions`, `delete_inbox_rule`,
`force_password_reset`, `block_ip`, `isolate_device`) did not complete. The cause is one of:

1. **No M365 connection** for this tenant (or the stored token is invalid) —
   `getM365AccessToken` (`apps/api/src/approvals/graph-access.ts`) returned nothing, so the
   playbook ran against `unavailableGraphClient`, which fails every call with a synthetic
   503. This is the single most likely cause in a fresh tenant.
2. **`block_ip`/`isolate_device`** — these have **no automated backend at all** anywhere in
   this codebase (no firewall/network-control or Defender-for-Endpoint integration exists).
   They are *designed* to always return a recoverable failure with manual steps
   (`packages/playbooks/src/playbooks/block-ip.ts` / `isolate-device.ts`) — this is not a
   bug to fix, it is the honest, current state of those two playbooks.
3. **A genuine Graph outage or permissions problem** — the access token's own scopes don't
   cover the call, or Microsoft's own API is degraded.
4. **A premise mismatch** — the target no longer matches the case's own premise (the user's
   UPN changed, the mailbox rule was already deleted by someone else) — `executePlaybook`
   refuses to execute at all in this case (P5-05 AC3), which looks identical to an execution
   failure from the action's own row, but the `error` text will say "premise... no longer
   holds" rather than naming a Graph HTTP status.

## Diagnose

1. **Read the action's own row** — `error` and the case transition's own `reason` both carry
   the specific cause:
   ```sql
   SELECT id, playbook, status, error, target FROM actions WHERE id = '<action-uuid>';
   SELECT to_state, reason, occurred_at FROM case_transitions
   WHERE case_id = '<case-uuid>' ORDER BY id DESC LIMIT 5;
   ```
2. **Read the full audit trail for this action** (P5-09) — `action_started` through
   `action_failed`, with the SAME `manual_steps` text the action's own row carries, plus
   whoever approved it and when:
   ```sql
   SELECT occurred_at, actor_type, actor_id, action, payload
   FROM audit_log WHERE subject_id = '<action-uuid>' ORDER BY id ASC;
   ```
3. **If the error names a Graph status/error code** (not "no automated backend" or "premise
   no longer holds"): check `connectors` for this tenant's own M365 connection health
   (`status`, `last_error`) and whether the stored access token has simply expired — this
   codebase does not yet refresh it automatically (`graph-access.ts`'s own documented scope
   boundary); re-running the OAuth consent flow (`/connectors/m365/connect`) re-establishes
   a fresh token.

## Mitigate

- **No M365 connection**: have the tenant (re-)connect via `/connectors/m365/connect`, then
  manually perform the action's own `manual_steps` text for THIS case while waiting — the
  case stays correctly flagged `awaiting_approval` in the meantime, so nothing is lost.
- **`block_ip`/`isolate_device`**: perform the `manual_steps` by hand (block the IP at your
  firewall/VPN/conditional-access policy; isolate the device from whatever endpoint console
  you actually use) — there is no "fix" beyond building that integration, which is separate,
  real future work, not a bug in this ticket.
- **Genuine Graph outage**: wait and retry — re-approving requires a FRESH signed token
  (the original one is already burned, single-use, ADR-0007) — generate and send a new
  approval link for the same action.
- **Premise mismatch**: do not blindly retry. Re-investigate the case first — the premise
  changing (e.g., someone else already disabled the user) may mean the situation already
  resolved itself, or that the stored target is simply stale.

## Prevent

A tenant with no M365 connection configured at all should never reach this failure in the
first place for a routine case — surfacing "no M365 connection" as a dashboard banner
*before* an action is even proposed is dashboard/frontend scope (not yet built, P6), tracked
there rather than worked around here.
