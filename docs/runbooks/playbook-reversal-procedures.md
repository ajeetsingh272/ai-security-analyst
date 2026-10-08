# Runbook: playbook reversal procedures

**AC3:** "each playbook's reversal procedure is written and verified by execution."

Each of the six playbooks (`packages/playbooks/src/playbooks/`) declares its own
`reversalProcedure` string — this document is the operator-facing expansion of those six
strings, plus the "verified by execution" evidence AC3 asks for. Two of the six genuinely
have an automated reversal CALL to verify; the other four do not, for reasons specific to
each, explained below rather than glossed over.

## `disable_user` — reversible, verified

**Reversal:** `PATCH /users/{id}` with `{ "accountEnabled": true }` (Graph's own "Enable
user" operation).

**Verified by execution:**
`packages/playbooks/src/__tests__/reversal-procedures.test.ts`'s own
`disable_user: PATCH accountEnabled: true re-enables a disabled user` — makes this exact
call against a Graph-shaped client with a user seeded as disabled, and confirms the user's
own `accountEnabled` flips to `true` afterward. Run fresh while writing this document:
```
pnpm --filter @sentinel/playbooks exec vitest run reversal-procedures
```
**Operator steps:** `PATCH https://graph.microsoft.com/v1.0/users/{id}` with that body,
authenticated as the tenant's own M365 connector (or via the Entra admin portal directly —
"Enable account" on the user's own profile does the identical thing).

## `force_password_reset` — reversible, verified

**Reversal:** `PATCH /users/{id}` with `{ "passwordProfile": { "forceChangePasswordNextSignIn": false } }`.
The user keeps their CURRENT password and is not prompted again — this does not reveal or
reset anything, it only clears the flag this playbook's own execution set.

**Verified by execution:** the same test file's
`force_password_reset: PATCH passwordProfile.forceChangePasswordNextSignIn: false clears
the flag` — seeds a user with the flag set, makes the exact PATCH, confirms it clears.

**Operator steps:** same PATCH via Graph, or the Entra admin portal's own "Require password
change" toggle on the user's profile, switched off.

## `revoke_sessions` — not reversible, by design

Graph itself has no "un-revoke" operation. The only way a revoked session comes back is the
user signing in again — which they were always going to do, since revoking sessions does
not touch the account's own password or enabled state. **There is nothing to reverse** —
document this to the approver BEFORE they tap Approve (the alert/approval prompt's own
copy), not as a surprise afterward.

## `delete_inbox_rule` — not reversible from Graph's side

Graph does not restore a deleted mail rule. If the rule turns out to have been legitimate
(a false positive), an operator recreates it BY HAND using the exact fields captured in the
action's own audit entry — `ActionsRepository.markSucceeded`'s own audit payload, and the
original `target.expectedRuleName`, are what the rule's own `displayName` was:
```sql
SELECT target, payload FROM actions a
JOIN audit_log al ON al.subject_id = a.id::text AND al.action = 'action_completed'
WHERE a.id = '<action-uuid>';
```
Recreate the rule in Outlook/the Exchange admin center with that same display name — the
rule's own CONDITIONS (what it forwarded, to where) are not captured by this action's own
target shape today; if that level of detail is needed for a specific recreation, it comes
from the original detection signal's own event data in ClickHouse, not from this table.

## `block_ip` / `isolate_device` — no automated backend at all

Neither playbook has ever called a real API for ANYTHING, including a forward action — see
`packages/playbooks/src/playbooks/block-ip.ts`/`isolate-device.ts`'s own doc comments. There
is nothing for THIS codebase to reverse because there is nothing it ever did. The reversal
is whatever an operator did manually when they executed the forward action by hand:

- `block_ip`: remove the rule from whichever firewall/VPN/conditional-access policy an
  operator used.
- `isolate_device`: un-isolate the device from whatever Defender for Endpoint / Intune
  console an operator used — once that integration exists at all.
