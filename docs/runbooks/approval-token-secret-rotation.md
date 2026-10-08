# Runbook: `APPROVAL_TOKEN_SECRET` rotation

**Risk this addresses:** ADR-0007's own risk table — "`APPROVAL_TOKEN_SECRET` leaks | Key
rotation with overlapping validity; tokens are short-lived so the exposure window is
bounded; rotation runbook in `docs/runbooks/`." This is that runbook.

**Guarantee at risk:** TG2 ("the AI never acts without approval") depends on this secret —
anyone who has it can mint a token that approves ANY action on ANY case for ANY tenant
(ADR-0007's own token format has no per-tenant key). A leak must be rotatable without
either (a) leaving the leaked secret valid indefinitely, or (b) failing every approval
link an owner has in their phone or inbox at the moment of rotation.

## How overlapping validity actually works

`verifyApprovalTokenShape`/`verifyAndConsume` (`@sentinel/approval-tokens`) accept **more
than one** secret for verification — each candidate is tried with the same timing-safe
comparison; `signApprovalToken` always signs with exactly one (the current one).
`ApprovalsConfig.previousTokenSecret` (`apps/api/src/routes/approvals.ts`) is the HTTP
surface for this: when set, BOTH the current and previous secret verify; only the current
one signs new tokens. Read from `APPROVAL_TOKEN_SECRET_PREVIOUS` — unset in ordinary
operation, set only during a rotation's own overlap window.

This is not a design-only claim. `packages/approval-tokens/src/__tests__/token.test.ts`'s
own "P5-11: secret rotation with overlapping validity" suite, and
`apps/api/src/__tests__/approval-token-rotation.integration.test.ts` (against the real
`/approvals/:token` endpoint, real Postgres, real Redis), both prove it end to end — a token
minted under the OLD secret before rotation still approves successfully once the NEW config
(current = new, previous = old) is deployed, and a fresh token minted under the NEW secret
during the same window ALSO succeeds. Both files were run fresh, not merely read, while
writing this runbook.

## Procedure

1. **Generate the new secret.** 32+ bytes of real randomness —
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
2. **Deploy with BOTH secrets set**, in this exact arrangement:
   - `APPROVAL_TOKEN_SECRET` = the NEW secret (this is what signs every token minted from
     this moment on).
   - `APPROVAL_TOKEN_SECRET_PREVIOUS` = the OLD (soon-to-be-retired) secret.

   Every token already in flight (an owner's own WhatsApp/Slack/email alert, up to 15
   minutes old per ADR-0007's own expiry) still verifies. Every NEW alert sent from this
   point signs with the new secret.
3. **Hold the overlap for at least 15 minutes** (one full token lifetime) past the deploy —
   long enough that nothing signed under the old secret can still be unexpired. Longer is
   fine; there is no reason to rush this step.
4. **Remove `APPROVAL_TOKEN_SECRET_PREVIOUS`** once the overlap window has passed. From this
   point, a token signed under the old secret is correctly rejected (`bad_signature`) — the
   leak is closed.
5. **If the leak is active (not a routine rotation)**: skip straight to a SHORT overlap (a
   few minutes, enough only for tokens already delivered to channels in the last few
   minutes) rather than the full 15 — the whole point of rotating under an active leak is to
   close the window as fast as the real in-flight tokens allow, not to maximise convenience.

## Verify the rotation actually worked

- **No failed approvals during the overlap** (T2) — check `audit_log` for
  `approval_rejected` entries with `payload.reason = 'bad_signature'` in the window; there
  should be none caused by the rotation itself (a GENUINE forged/tampered token still
  correctly produces one, which is not a problem).
  ```sql
  SELECT occurred_at, subject_id FROM audit_log
  WHERE action = 'approval_rejected' AND payload->>'reason' = 'bad_signature'
    AND occurred_at BETWEEN '<rotation-start>' AND '<overlap-end>';
  ```
- **After removing the previous secret**: confirm a deliberately old-signed test token is
  rejected (`approval-token-rotation.integration.test.ts`'s own last test case is exactly
  this check, automated).

## If something goes wrong mid-rotation

Re-add `APPROVAL_TOKEN_SECRET_PREVIOUS` with the OLD secret immediately — this is the entire
point of the two-variable design: rolling back is re-adding one environment variable, never
a code change or a deploy that could itself fail under pressure.
