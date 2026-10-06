# Detection engineering guide

This is for a new detection engineer shipping their first Sigma rule into Sentinel. It assumes
nothing about the compiler ([ADR-0004](adr/0004-sigma-compiled-ast.md)) — you should be able to
write, map, fixture and ship a rule end to end from this page alone.

If you only want the checklist, see [CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-detection-rule).
This guide is the "why", with a real worked example.

## 1. Anatomy of a rule

Every rule lives at `detections/rules/<id>.yml` — flat, no per-product subdirectory. Here is
`mailbox-audit-disabled.yml`, a complete, minimal rule:

```yaml
title: Mailbox audit logging disabled
id: 8f1a2b3c-0001-4a00-9000-000000000011
status: stable
description: >
  Detects AuditEnabled being set to false on a mailbox — a direct
  defense-evasion step that removes the record an investigator would
  otherwise use to reconstruct what an attacker did inside the mailbox.
owner_description: >
  Someone turned off the activity record-keeping for a mailbox.
  Attackers do this so their actions inside an account cannot be
  reviewed later.
author: Sentinel detection engineering
date: 2026/10/06
tags:
  - attack.t1685.002
logsource:
  category: application
  product: m365
  service: exchange
detection:
  selection:
    Operation: 'Set-Mailbox'
    AuditEnabled: 'False'
  condition: selection
falsepositives:
  - IT deliberately disabling audit on a test or service mailbox
level: high
```

Two fields are easy to confuse and both are mandatory, checked by CI, and serve different readers:

- **`description`** — engineer-facing. What the rule technically detects, written for the next
  detection engineer who reads this file, not a customer.
- **`owner_description`** — the text a customer's mailbox/tenant owner actually reads in an
  alert. Plain English, no product jargon, no internal vocabulary. A denylist
  (`services/detect/internal/sigmac/jargon_test.go`) checks this at build time — words like
  "tenant", "payload", "endpoint" fail CI here specifically because a non-technical reader
  shouldn't have to decode them. (This guide's own worked example in §6 hit this check for
  real — see there for what the failure looks like and how it's fixed.)

`level` is one of `low` / `medium` / `high` / `critical`. `critical` is not just "more severe" —
a critical rule bypasses the normal correlation/AI-analyst path entirely and alerts the customer
directly, even if that whole plane is down (`SECURITY.md`'s TG4). Reserve it for detections where
that bypass is actually warranted; see `docs/architecture/overview.md` §3.5 for what already
carries it.

## 2. The supported Sigma subset

The compiler ([ADR-0004](adr/0004-sigma-compiled-ast.md)) only implements a deliberate subset of
real Sigma. This is everything it supports — if your detection needs something not listed here,
read §2.3 before writing a rule that won't parse.

### 2.1 Field matching

A selection is a map of field names to one or more values, implicitly ANDed across fields and
ORed across a field's own value list:

```yaml
selection:
  Operation: 'New-InboxRule'          # bare field name = equals
  ClientAppUsed:                       # a list = OR across values
    - 'Browser'
    - 'Mobile Apps'
```

A field name may carry exactly one value modifier, suffixed with `|`:

| Suffix | Match |
|---|---|
| *(none)* | exact equality |
| `\|contains` | substring |
| `\|startswith` | prefix |
| `\|endswith` | suffix |
| `\|re` | regular expression (Go `regexp` syntax) |
| `\|base64` | value is base64; decoded and compared |
| `\|all` | combine with another modifier to require **every** value match, not just one |

```yaml
selection:
  CommandLine|contains: 'powershell'
  Parameters|all:
    - '-nop'
    - '-w hidden'
```

### 2.2 Condition grammar

`condition:` is a small boolean expression over selection names:

```
expr    := orExpr
orExpr  := andExpr ("or" andExpr)*
andExpr := notExpr ("and" notExpr)*
notExpr := "not" notExpr | primary
primary := IDENT | ofExpr | "(" expr ")"
ofExpr  := (NUMBER | "all") "of" IDENT
```

`IDENT` may use Sigma's own `*` wildcard (`1 of selection*` matches if any selection whose name
starts with `selection` matched). Examples:

```yaml
condition: selection and not filter
condition: 1 of selection*
condition: all of them        # "them" is sigma's own name for "every selection in this rule"
```

### 2.3 Windowed (aggregation) rules

Appending a pipe to the condition routes the rule to the **windowed engine** (ClickHouse-scheduled
queries, not the in-stream compiler) instead of evaluating it per event:

```yaml
condition: selection | count() by UserId, ClientIP > 1 within 10m
```

Grammar: `<expr> | count() by FIELD [, FIELD]* COMPARATOR NUMBER [within DURATION]`. `count` is
the only aggregation op this subset supports; `COMPARATOR` is one of `< <= > >= ==`. More than one
`GroupBy` field means "group by the first field, count DISTINCT values of the rest" —
`impossible-travel.yml` is the canonical example (group by `UserId`, count distinct `ClientIP`).

A windowed rule's own schedule interval (30s–15min, by `level`) means "detection latency under
100ms" (P2-11's own exit criterion) **does not apply** to it — that number is specifically about
the in-stream engine.

### 2.4 Field mapping — the subset's actual boundary

Every field name your rule's selections reference (`Operation`, `ClientIP`, `AuditEnabled`, …)
must have an entry in `services/detect/internal/sigmac/fieldmap.go`'s `fieldMap` table. This is
**not** a convenience lookup with an implicit fallback — a field with no entry is a build error,
by design (AC4 of P2-01: "a field mapping failure is an error, not a silent no-match"). If it
silently fell back to "never matches", a typo'd field name would produce a rule that compiles,
ships, and quietly never fires — far worse than a build failure.

**If your rule needs a field that isn't in the table yet**: add one line to `fieldMap`, mapping
your Sigma field name to `unmapped.<SameName>` (the convention every raw M365 audit-log attribute
already uses) or `metadata.<name>` if it's something this pipeline itself derives (enrichment,
not a vendor-sent value). This is a tiny, reviewable, one-line PR — see §6 for a real one.

**If the detection logic genuinely exceeds this subset** (you need an operator this grammar
doesn't have, a join across event types, anything the AST literally cannot express) — that is a
signal to extend the compiler itself (file a ticket; `services/detect/internal/sigmac` and
`internal/windowed` own that), not something to work around in a rule file. Do **not** reach for
the emergency hotfix path (§8) to get around a subset limitation — it runs through the exact same
interpreter and subset, just without waiting for a PR.

## 3. MITRE ATT&CK mapping

Every rule needs at least one `tags:` entry of the form `attack.tXXXX` or `attack.tXXXX.YYY`.
CI validates every tag against a real, pinned ATT&CK catalogue
(`services/detect/internal/attck`) — an unknown, deprecated, or **revoked** technique ID fails the
build. Revocation is a real thing that happens: ATT&CK v19.x revoked `T1562.001`/`T1562.008` in
favor of `T1685`/`T1685.002` mid-way through this project's own rule corpus, and five already-
shipped rules had to be corrected. If CI rejects your tag as "revoked", `attck.Lookup` in that
package will tell you the replacement — update the tag, don't suppress the check.

## 4. Fixtures — and why the negative one is not optional

Every rule needs exactly two fixtures: `detections/fixtures/<id>.positive.json` (an event that
**must** fire the rule) and `<id>.negative.json` (an event that **must not**). Both are flat
`map[string]string`, in the same `metadata.*`/`unmapped.*`/bare-field shape the rule's own
selections read.

**A rule without a negative fixture is a false-positive generator CI cannot catch.** This is not
a hypothetical: `anonymous-proxy-signin.yml` shipped in P2-06 with a selection that only checked
`ResultStatus: 'Success'` — no field distinguishing an anonymiser-origin sign-in from any other
successful sign-in. It matched **every single successful sign-in**, unconditionally, for an
entire release. Nothing caught it, because its negative fixture was itself built against the same
blind spot (a "successful sign-in with no proxy" event that, by the rule's own broken logic,
still matched). The fix (P2-09) added a real discriminating field (`IsAnonymousProxy`) once threat
-intel enrichment existed to populate it. The lesson that generalizes: **write the negative
fixture to be the closest plausible event that should NOT match**, not an unrelated one — a
negative fixture that's trivially different from the positive one proves nothing.

Run `pnpm detections:validate` (or `bash scripts/validate-detections.sh`) to check both fixtures
against the rule and regenerate the compiled corpus. If it reports a diff, that diff **is** the
expected generated output — commit it alongside your rule, the same as any other generated-code
step in this repo (`go run ./cmd/sigmac-gen` from `services/detect`, same convention `docs/
architecture/data-model.md` and `go/sentinelschema` already use for their own generated output).

## 5. Worked example: adding one real rule

This is a real rule added while writing this guide, not a hypothetical — `tenant-audit-log-
disabled.yml`, detecting `Set-AdminAuditLogConfig` turning off unified audit log ingestion
tenant-wide (the same defense-evasion pattern `mailbox-audit-disabled.yml` already covers at one
mailbox's scope, here at the whole organization's scope).

**Step 1 — write the rule** (`detections/rules/tenant-audit-log-disabled.yml`):

```yaml
title: Tenant-wide unified audit logging disabled
id: 8f1a2b3c-0001-4a00-9000-000000000041
status: stable
description: >
  Detects UnifiedAuditLogIngestionEnabled being set to false at the
  tenant level (Set-AdminAuditLogConfig) — the same defense-evasion
  pattern mailbox-audit-disabled.yml already covers at a single
  mailbox's scope, here at the whole tenant's scope.
owner_description: >
  Someone turned off the company-wide activity record-keeping for the
  whole organization. Attackers do this so none of their actions
  anywhere in the company's account can be reviewed later.
author: Sentinel detection engineering
date: 2026/10/06
tags:
  - attack.t1685.002
logsource:
  category: application
  product: m365
  service: azuread
detection:
  selection:
    Operation: 'Set-AdminAuditLogConfig'
    UnifiedAuditLogIngestionEnabled: 'False'
  condition: selection
falsepositives:
  - A deliberate, time-boxed change during a tenant migration or a licensing change that temporarily removes unified audit log entitlement
level: critical
```

**Step 2 — add the two fixtures:**

`detections/fixtures/tenant-audit-log-disabled.positive.json`:
```json
{"metadata.product": "m365", "metadata.operation": "Set-AdminAuditLogConfig", "unmapped.UnifiedAuditLogIngestionEnabled": "False"}
```

`detections/fixtures/tenant-audit-log-disabled.negative.json`:
```json
{"metadata.product": "m365", "metadata.operation": "Set-AdminAuditLogConfig", "unmapped.UnifiedAuditLogIngestionEnabled": "True"}
```

**Step 3 — run `bash scripts/validate-detections.sh`.** This is where it actually failed the
first time, for real:

```
tenant-audit-log-disabled.yml:26: rule "Tenant-wide unified audit logging disabled":
selection "selection": field "UnifiedAuditLogIngestionEnabled" has no entry in the
OCSF field mapping table (fieldmap.go) — AC4: this is an error, not a silent no-match
```

This is §2.4's own boundary, hit for real. The fix is the one-line addition §2.4 describes, in
`services/detect/internal/sigmac/fieldmap.go`:

```go
"UnifiedAuditLogIngestionEnabled": "unmapped.UnifiedAuditLogIngestionEnabled",
```

**Step 4 — run it again.** This time it failed a *different* check, also for real:

```
rule "Tenant-wide unified audit logging disabled": owner_description contains
unexplained jargon "tenant": "...so none of their actions anywhere in the tenant
can be reviewed later."
```

This is §1's jargon denylist. Fixed by rewording — "the tenant" became "the company's account" —
and the validator passed clean. `go test ./services/detect/...` then passes, including a
generated `TestRule_tenant_audit_log_disabled` that `sigmac-gen` wrote automatically from the two
fixtures.

Nothing about this sequence was hypothetical or smoothed over for this guide — both failures are
exactly what a new engineer should expect to hit, and exactly how to read and fix them.

## 6. Tuning a noisy rule — don't weaken it, suppress it

A rule that fires too often in one customer's environment is a tuning problem, not necessarily a
rule-quality problem — the same pattern might be perfectly diagnostic everywhere else. Weakening
the rule's own selection to fix one customer's noise degrades it for everyone. Instead, use
suppression (P2-10, `POST /suppressions`): scope it to the specific tenant, rule, and (optionally)
entity that's noisy, with a mandatory reason and an automatic 30-day expiry. A suppressed signal
is still stored and counted — nothing is silently dropped — it just doesn't escalate. See
`docs/architecture/overview.md` §3.5's own suppression section for the full mechanism.

## 7. The emergency path — and when *not* to use it

If a detection is urgent enough that waiting for a normal rule PR (review, fixtures, CI, deploy)
is itself the risk, P2-12's hotfix rule path (`POST /hotfix-rules`, platform operations team only)
lets an interpreted rule go live immediately, capped at 10 active at once, expiring automatically
after 7 days with no extension. It runs through the **exact same** Sigma subset this guide
describes (§2) — it is a faster way to ship an ordinary rule in an emergency, not a way to express
something outside the subset, and not a substitute for fixtures or MITRE mapping on the
*eventual* real rule the hotfix is explicitly supposed to force (its own expiry exists to make
that happen). Reach for it only for a genuine, time-critical gap; using it as a shortcut around
normal review for an ordinary new rule defeats the entire reason it exists.

## 8. Where to go next

- [`CONTRIBUTING.md`](../CONTRIBUTING.md#adding-a-detection-rule) — the quick checklist version of §1-4.
- [`docs/architecture/overview.md`](architecture/overview.md) §3.5 — the detection plane's own architecture (both engines, the critical bypass, enrichment, suppression, hotfix rules, load testing).
- [ADR-0004](adr/0004-sigma-compiled-ast.md) — why the compiler exists and what it deliberately does not support.
- `services/detect/internal/sigmac` — the parser/IR/interpreter source, if you need ground truth beyond this guide.
