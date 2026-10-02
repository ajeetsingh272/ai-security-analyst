# ADR-0006: Tiered LLM routing with a deterministic grounding validator

- **Status:** Accepted
- **Date:** 2026-10-02
- **Phase:** P4

## Context

Two requirements pull in opposite directions.

**Cost.** ~100,000 cases per day across 10,000 tenants. Running a frontier model over every
case at full context would cost multiples of the ₹1,800/tenant/month budget in constraint C1.

**Trust.** The product promises that every sentence in a report points to a real recorded
event (constraint C2, product guarantee #1). The buyer cannot verify a security claim
themselves. A single confident fabrication — a named employee accused of something that did
not happen — ends the customer relationship and plausibly the company.

Prompt instructions do not satisfy the second requirement. "Do not speculate" reduces
fabrication; it does not prevent it, and it provides no evidence that it worked.

## Decision

**Two mechanisms: tiered routing for cost, mechanical validation for trust.**

### Tiered routing

| Stage | Model | Input | Output |
|---|---|---|---|
| Triage | `claude-haiku-4-5-20251001` | Case summary, signals, entity baseline | dismiss / escalate + reason |
| Investigation | `claude-opus-5` | Full case, tool access, tenant context | Structured verdict with claims |

The majority of cases are dismissed at triage by the cheap model. Only escalated cases reach
the expensive one. The tenant context block — org profile, baselines, prior case summaries,
rule descriptions — is stable across calls for a tenant and is **prompt-cached**, which is
the single largest cost lever available.

Dismissals are never silent: each is written to the daily digest with its reason, satisfying
product guarantee #3.

### Structured output

The investigation model must return claims, not prose:

```json
{
  "severity": "critical",
  "title": "Priya Sharma's mailbox was accessed from an unfamiliar country",
  "claims": [
    {
      "text": "A successful sign-in occurred from 185.220.x.x (Russia) at 02:14 IST.",
      "evidence_ref": ["evt_01HQ8X...", "evt_01HQ8Y..."]
    }
  ],
  "attack_chain": ["T1078.004", "T1114.003"],
  "recommended_actions": [
    { "playbook": "revoke_sessions", "urgency": "now", "blast_radius": "single_user" }
  ]
}
```

### The grounding validator

Ordinary deterministic code, running after every investigation:

1. Extract every `evidence_ref` from every claim
2. Query ClickHouse for those `event_id`s, **scoped to this tenant**
3. Assert each resolves, and falls inside the case time window
4. Any unresolvable reference fails the **entire** report
5. On failure: retry once with the validation error fed back. On second failure: discard the
   report, emit a rule-only alert, page on-call, flag the case for human review

The model is never asked to self-certify, and is never trusted to. Tenant scoping in step 2
is also a security control: it makes cross-tenant evidence citation impossible rather than
merely unlikely.

## Alternatives considered

### A: One frontier model for everything, no validator

Simplest, best narrative quality. Rejected on both constraints at once: it breaches the cost
budget by a wide margin, and it leaves the central product promise resting on a prompt.

### B: Self-critique — a second LLM call asks "is this grounded?"

Popular and cheap to implement. Rejected because it is not a control. The critic shares the
generator's failure modes, cannot verify a fact against the database, and produces an
answer that is itself unverifiable. It converts an unverified claim into an unverified claim
with a second opinion attached.

### C: Fine-tuned small model

Lower marginal cost at volume. Rejected for now: we have no labelled incident corpus, and
fine-tuning would freeze detection quality against the data we had on the day we trained.
Revisit after the pilot produces labelled cases.

### D: Retrieval-only, no generation — templated reports

Perfectly grounded by construction, and genuinely considered. Rejected because the plain-
English explanation *is* the product; templates were what the incumbent tools already did,
and what customers already ignore.

## Consequences

### Good

- Unsourced claims cannot reach a customer — enforced by a database query, not a prompt
- Cost scales with escalated cases, not with event volume
- Prompt caching makes the dominant token cost nearly free after the first call per tenant
- Grounding rejection rate becomes a measurable canary for prompt or model drift
- Model swaps are routine: the validator is model-agnostic

### Bad

- Every report costs an extra set of ClickHouse queries (small, but real)
- Rejected reports degrade the customer experience to a terse rule-only alert
- The model must be constrained to structured output, which measurably reduces narrative
  fluency compared to free prose
- Two model tiers means two prompt suites and two eval suites to maintain

### Risks and how they are mitigated

| Risk | Mitigation |
|---|---|
| Model cites a real event that does not support the claim | Validator checks existence and window, not semantics. Mitigated by the eval suite's semantic assertions on golden cases, and by surfacing the cited events inline in the UI so a human can see the gap |
| Grounding rejection rate rises after a model update | Alert at >2%; model version pinned in config; eval suite runs in CI against pinned versions |
| Triage model dismisses a true positive | Dismissals are sampled and reviewed; any rule marked `critical` bypasses triage entirely |
| LLM cost per tenant exceeds plan | Per-tenant daily token budget with a hard cap; exceeding it degrades to rule-only alerts and notifies ops |

## Revisit when

The pilot produces a labelled corpus large enough to evaluate a fine-tuned triage model, or
grounding rejection stabilises near zero for two quarters (which would justify relaxing the
retry path, not the validator).
