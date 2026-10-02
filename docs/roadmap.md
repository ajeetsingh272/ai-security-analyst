# Roadmap

> Single source of truth for *what* ships and *when*. The machine-readable version that
> generates the GitHub board and the progress dashboard is
> [`planning/backlog.json`](../planning/backlog.json). Edit that, not this — this document
> explains the reasoning; the JSON is the data.

---

## A note on the original timeline

The product brief proposed: core ingest plus 40 detections in Month 1, the full AI analyst
by Month 1.5, MSP console and a live pilot by Month 4.

That sequence is right. The sizing is roughly **2–3× optimistic** for a production
multi-tenant SaaS holding customer security telemetry. The gap is not in the happy path —
a demo of M365 ingest and a dozen rules genuinely is a few weeks' work. The gap is in
everything that makes it sellable: tenant isolation that survives an audit, connector
checkpointing that does not lose events during a vendor outage, detection rules with
negative fixtures, an approval path that cannot be replayed, and an audit log a customer's
insurer will accept.

Those are not polish. For a security product they are the product. Shipping the demo version
of them is how security startups fail their first enterprise security review.

The schedule below keeps the brief's ordering exactly and sizes it honestly. Where scope can
be cut to compress, it is marked **[cuttable]**.

---

## Phases

| Phase | Name | Duration | Exit criterion |
|---|---|---|---|
| **P0** | Foundation | 3 wks | A developer clones, runs one command, and has the full stack running locally with two isolated tenants |
| **P1** | Ingest & storage | 4 wks | M365 events flow to ClickHouse continuously for 72 h with zero loss across an induced outage |
| **P2** | Detection engine | 4 wks | 40 MITRE-mapped rules, every one with a passing positive and negative fixture, sustaining 30k EPS |
| **P3** | Correlation | 3 wks | Measured signal-to-case reduction ≥ 10:1 on replayed real-shaped data |
| **P4** | AI analyst | 4 wks | 100% of delivered reports pass grounding validation; eval suite green on 50 golden cases |
| **P5** | Response & alerting | 3 wks | Attack to approved fix under 3 minutes end to end, fully audited |
| **P6** | Product surface | 5 wks | A pilot customer onboards themselves in under 15 minutes and receives a weekly report |
| **P7** | Scale & compliance | 8 wks | 30k EPS sustained load test green; SOC 2 Type I evidence collected |

**Total to pilot-ready (P0–P6): ~26 weeks.** The brief's Month 3–4 pilot target is
achievable only by cutting the items marked cuttable and accepting a single-connector,
single-tenant-class product.

---

## P0 · Foundation — 3 weeks

Everything that would be painful to retrofit. Tenant isolation and the audit log are here
and not later, deliberately: both are structural, and bolting them on afterwards means
rewriting every query and every mutation in the system.

**Epics:** repository and CI · design system · control-plane schema and tenant isolation ·
authentication · local development stack · observability baseline

**Exit:** `pnpm install && pnpm dev:stack && pnpm dev` produces a running system. The
cross-tenant isolation test passes. The audit chain verifier passes on seeded data.

---

## P1 · Ingest & storage — 4 weeks

The Microsoft 365 connector end to end, because M365 is where the money is: Business Email
Compromise against M365 mailboxes is the single attack that justifies the purchase.

**Epics:** connector framework · M365 connector · OCSF normalisation · ClickHouse schema and
ingest · raw archive and replay · ingest observability

The replay tooling is not optional and not deferrable. It is how we recover from a mapping
bug, and it is the mechanism behind the free "10-minute scan of your last 7 days" that the
go-to-market plan depends on for conversion.

**Exit:** events flow continuously for 72 hours. Killing the connector mid-batch and
restarting loses nothing and duplicates nothing observable downstream.

---

## P2 · Detection engine — 4 weeks

**Epics:** Sigma compiler · in-stream rule evaluation · windowed ClickHouse rules · the
first 40 rules · MITRE mapping and enforcement · critical-alert bypass path

The 40 rules are chosen by what actually happens to small businesses, not by what is easy to
detect: impossible travel, new inbox forwarding rule to an external address, mass mailbox
download, OAuth consent grant to an unverified app, MFA method registration by an attacker,
anonymous-proxy sign-in, mass file download or deletion, privileged role assignment.

**Exit:** 40 rules, each with a positive and negative fixture passing in CI. 30k EPS
sustained in the load test. The chaos test that kills the analyst still delivers critical
alerts.

---

## P3 · Correlation — 3 weeks

The component that makes the product viable, and it contains no AI.

**Epics:** entity resolution · signal clustering · case lifecycle · case scoring ·
reduction-ratio SLO instrumentation

**Exit:** reduction ratio ≥ 10:1 measured on replayed data. Case state transitions are fully
reconstructible from the append-only log.

---

## P4 · AI analyst — 4 weeks

**Epics:** investigation loop and tools · structured output contract · **grounding
validator** · tiered routing and prompt caching · eval suite · cost controls and budgets

The grounding validator is the highest-risk item in the entire plan, because the product's
central promise rests on it and because it is the thing a reviewer is most likely to wave
through as "the prompt handles it". It gets its own tickets, its own tests, and its own
dashboard metric.

**Exit:** 100% of delivered reports pass validation. The eval suite is green on 50 golden
cases covering severity accuracy and grounding. Per-tenant cost is inside budget at
projected volume.

---

## P5 · Response & alerting — 3 weeks

**Epics:** notification channels (WhatsApp, Slack, email) · approval tokens · playbook
executor · audit log integration · failure and rollback handling

**Exit:** the full brief scenario — 02:14 detection, 02:18 alert, 02:21 fixed — reproduced
in an automated end-to-end test, with every step present in the verified audit chain.

---

## P6 · Product surface — 5 weeks

**Epics:** tenant dashboard · case detail and evidence view · MSP multi-client console ·
weekly owner report · self-serve onboarding · **the free 10-minute security scan**

The free scan is the commercial centrepiece. It replays a prospect's last 7 days through the
detection engine and produces a findings report. The go-to-market plan assumes it converts
1 in 4 trials, which makes it a revenue feature, not a marketing page.

**Exit:** a pilot customer onboards unassisted in under 15 minutes and receives their first
weekly report.

---

## P7 · Scale & compliance — 8 weeks

**Epics:** Google Workspace connector · AWS and Azure connectors · hot-tenant sharding ·
ClickHouse cold tiering · SOC 2 Type I evidence · multi-region readiness **[cuttable]** ·
customer-authored detections **[cuttable]**

**Exit:** 30k EPS sustained for one hour with p95 alert latency under 3 minutes. SOC 2
Type I evidence collected.

---

## Pilot success criteria

Taken directly from the brief and instrumented as dashboard metrics from P3 onward, so they
are measured continuously rather than assessed at the end:

| Metric | Target | Instrumented in |
|---|---|---|
| Raw signals reaching a human | < 10 per 100 | P3 |
| Of those, true positives | majority | P4 |
| Critical alert to owner's phone | < 3 min p95 | P5 |
| Free scan trial-to-paid conversion | ≥ 25% | P6 |
| Cost of goods per tenant | < ₹1,800/month | P4 |

A target without a measurement is a wish. Each of these has a ticket that builds the metric
before the phase that must hit it.

---

## Dependencies between phases

```
P0 ──▶ P1 ──▶ P2 ──▶ P3 ──▶ P4 ──▶ P5 ──▶ P6 ──▶ P7
       │             │             │
       └─────────────┴─────────────┘
         P6 dashboard work can start in parallel from P3
         once the case contract is frozen
```

The case contract (`packages/schema`) freezes at the end of P3. That is the gate that lets
dashboard work parallelise, and it is why schema lives in its own package from P0.
