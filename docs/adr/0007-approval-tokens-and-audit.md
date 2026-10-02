# ADR-0007: Signed single-use approval tokens and a hash-chained audit log

- **Status:** Accepted
- **Date:** 2026-10-02
- **Phase:** P5

## Context

The product's safety story rests on one sentence: *the AI only acts after a human approves*.
That approval arrives at 2am, on a phone, over WhatsApp, from an owner who is half asleep.
The actions behind it are destructive by design — disabling an account, revoking every
session, deleting a mailbox rule.

This creates an unusually hostile set of requirements for an "Approve" button:

- The link travels through WhatsApp and Slack, which means it is logged by Meta, may be
  forwarded, and may be previewed by link-expansion bots that issue a GET
- The approver is not authenticated in a browser session at that moment
- A replayed approval must not re-execute a destructive action
- Months later, a customer or auditor may ask *who approved what, and when*, and the answer
  must be defensible even if our own operators are the ones being questioned

## Decision

### Approval tokens

A token is a signed, opaque value bound to exactly one decision:

```
payload = { case_id, action_id, tenant_id, approver_id, nonce, exp }
token   = base64url(payload) + "." + HMAC-SHA256(payload, APPROVAL_TOKEN_SECRET)
```

- **Expires in 15 minutes.** An alert older than that requires logging into the dashboard
- **Single use.** The nonce is burned in Redis on first use and persisted in Postgres;
  a second presentation fails closed
- **Bound to one action on one case for one tenant.** It cannot be replayed against a
  different case, escalated to a different action, or used across tenants
- **GET never mutates.** The link opens a confirmation page; execution requires a POST.
  This is what prevents a link-preview bot from disabling an executive's account
- **Failure is closed.** Invalid, expired, reused or malformed means no action, an explicit
  message, and an audit entry

Destructive actions (`disable_user`, `isolate_device`, `force_password_reset`) additionally
require re-authentication regardless of token validity. A valid token is necessary but not
sufficient for the actions that hurt most.

### Audit log

Append-only and hash-chained in Postgres:

```sql
CREATE TABLE audit_log (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type   TEXT NOT NULL,   -- human | ai | system | connector
  actor_id     TEXT NOT NULL,
  action       TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  payload      JSONB NOT NULL,
  prev_hash    BYTEA NOT NULL,
  entry_hash   BYTEA NOT NULL
);
```

- `entry_hash = SHA256(prev_hash || canonical_json(row_without_hashes))`
- The application role is granted `INSERT` and `SELECT` only — **no `UPDATE`, no `DELETE`**
- A daily job verifies the chain and alerts on any break
- `actor_type` distinguishes AI from human decisions, which is what makes the "who decided
  this?" question answerable

Tamper-evidence is a property of the schema and the grants, not of a convention anyone has
to remember.

## Alternatives considered

### A: Magic-link session, then normal authenticated action

More conventional and reuses the existing session system. Rejected on latency and friction:
it adds a login round trip at 2am to a product whose headline claim is "7 minutes from attack
to fix". The bounded, single-purpose token achieves the same security outcome with one tap,
because its blast radius is one action on one case.

### B: Approve by replying "YES" in WhatsApp

Lowest possible friction. Rejected: WhatsApp message authenticity is weak for this purpose,
the binding between a reply and a specific case is ambiguous when two alerts arrive close
together, and there is no defensible audit artefact. The failure mode — the wrong account
disabled because two alerts overlapped — is exactly the one the product cannot have.

### C: Standard mutable audit table

Simpler, and what most products ship. Rejected because the audit log is a trust artefact
sold to the customer, and in an incident our own operators may be the subject of the
inquiry. "Trust our access controls" is strictly weaker than "the chain verifies".

## Consequences

### Good

- One tap from a phone, with a blast radius of exactly one action
- Replay, forwarding and link-preview attacks all fail closed
- Destructive actions carry a second factor
- The audit log is defensible to a customer, an auditor and a court
- Clean separation of AI-initiated from human-approved decisions in the record

### Bad

- 15-minute expiry means genuinely delayed approvals must go through the dashboard — this
  will generate support contacts and must be explained well in the UI
- Hash chaining makes bulk audit writes serial per tenant, a throughput ceiling we accept
- The chain cannot be repaired; a verified break is a permanent, visible incident
- Nonce burning adds a Redis dependency on the approval path, with a Postgres fallback

### Risks and how they are mitigated

| Risk | Mitigation |
|---|---|
| `APPROVAL_TOKEN_SECRET` leaks | Key rotation with overlapping validity; tokens are short-lived so the exposure window is bounded; rotation runbook in `docs/runbooks/` |
| Owner's phone is compromised | Destructive actions require re-authentication; per-tenant action rate limit; all approvals surfaced in the daily digest so anomalous ones are visible |
| Redis unavailable on the approval path | Nonce check falls back to Postgres unique constraint — slower, still correct, still single-use |
| Audit chain break from a bad migration | Migrations touching `audit_log` require an ADR and a two-person review; the verifier runs in CI against a seeded chain |

## Revisit when

A customer contract requires externally anchored audit (e.g. notarised digests), or
re-authentication friction is measurably costing us response time in pilot data.
