# ADR-0012: A separate, sandboxed evaluation path for customer-authored rules

- **Status:** Accepted
- **Date:** 2026-10-09
- **Phase:** P7
- **Supersedes / Superseded by:** Supersedes ADR-0004 §Decision, for customer-authored
  rules only. ADR-0004's decision is unchanged for platform-authored rules — this ADR does
  not reopen "compile to Go at build time" as the right answer for the ~150-rule reviewed
  corpus; it answers a question ADR-0004 explicitly deferred ("Revisit when: customer-
  authored custom detections become a contractual requirement").

## Context

P7-10: tenants want to author their own detection rules without waiting on a Sentinel
deploy. ADR-0004 built exactly one evaluation path, and it assumes every rule it runs was
reviewed in a pull request before it ever reaches production: a MITRE tag is mandatory, a
build-time compiler step rejects malformed rules, and nothing reaches the corpus without a
human maintainer's sign-off. None of that is available for a rule a tenant submits through
an API at 2am.

ADR-0004 anticipated this split and named it directly, twice. Its "Revisit when" clause is
this ticket's own trigger. Its rejected Alternative B ("compile to a WASM module per rule")
was rejected only for the problem ADR-0004 had at the time — hot-reload latency, which a
fast CI pipeline already solves — not for the problem this ADR actually has: isolating code
whose author is not a reviewed Sentinel engineer. That rejection does not carry over
automatically, and this ADR re-examines it on its own terms below.

The real new constraints, concrete:

- A customer rule must not be able to run unboundedly (CPU, memory, wall-clock) — one
  tenant's bad rule must not degrade detection for every other tenant sharing the same
  worker.
- A customer rule must not be able to see another tenant's events, under any circumstance,
  including a bug in the rule itself.
- A customer rule must not reach "live" without passing its own author-supplied fixtures —
  the same "untested rule is an outage" principle ADR-0004 already established, but
  enforced at activation time (there is no deploy step in this path to gate on).
- This is explicitly a lower trust tier than the reviewed corpus: a customer rule's own
  declared `level: critical` must never get the P2-08 direct-alert bypass, which exists as a
  guarantee specifically about rules that passed human review.

## Decision

Customer-authored rules get their own evaluation path, entirely separate from the compiled
corpus and from the existing platform-only hotfix path (P2-12) — not a third option bolted
onto either.

**1. A restricted Sigma dialect, not the full language.** A customer rule is parsed by the
exact same `sigmac.Parse` every platform rule goes through (one parser, one IR — a second,
drifting implementation of Sigma syntax is a worse risk than reusing the real one), then
validated against limits no platform rule is held to, because a platform rule's complexity
is already bounded by code review and none of this validation existed before this ticket:

| Limit | Value | Why this number |
|---|---|---|
| Engine | in-stream only, no `Aggregation` | Mirrors the hotfix path's own existing constraint (0008_hotfix_rules.sql). A windowed rule compiles to a single ClickHouse query that spans every tenant's rows in one scan (`windowed.BuildQuery`'s `GROUP BY tenant_id`, no `WHERE tenant_id` at all) — safe today only because every windowed rule is platform-reviewed. Scoping that query per-tenant is real, separable future work, not something this ADR silently assumes away. |
| Selections per rule | 20 | The compiled corpus's own largest rules sit under this; a legitimate detection rarely needs more. |
| Fields per selection | 10 | Same reasoning — generous relative to the real corpus, not arbitrary. |
| Values per field | 10 | Bounds the OR-fan-out `evaluateFieldMatch` walks per field. |
| Condition AST depth | 8 | `evaluateCondition` recurses one Go stack frame per level; 8 is far beyond any rule anyone has written, and is itself an a priori bound, not a measured one — cheap to raise later if a real rule needs more. |
| Regex pattern length | 200 characters | Go's `regexp` package is RE2 — matching is linear in input length regardless of pattern, so this bounds compile cost and readability, not a catastrophic-backtracking risk, which RE2 cannot have by construction. |
| Total rule YAML size | 8 KB | A backstop against a rule that satisfies every limit above individually but is still absurdly large (e.g. thousands of short values) — this is the one limit that catches the shape the per-field limits don't by themselves. |
| Active rules per tenant | 25 | Bounds one tenant's own total per-event evaluation cost — the AC3 concern restated as a number, not just a mechanism. |

A rule failing any of these is rejected before it is ever evaluated against a real event —
this is the actual load-bearing safety mechanism, not a runtime kill switch. It works
because the restricted dialect is provably not Turing-complete: `sigmac.Evaluate` is a
finite tree-walk with no loop whose iteration count depends on event content, over an AST
whose own size is now capped at submission time. There is no rule expressible in this
dialect that can run forever, the same way there is no SQL `SELECT` that can run forever
just because a `WHERE` clause is complicated — boundedness comes from the shape of the
language, not from watching it run and hoping to catch it misbehaving.

**2. A runtime wall-clock budget, as defense in depth, not as the primary mechanism.** Each
evaluation of each active customer rule against each event is timed. A rule exceeding 5ms
on a single event five times in a rolling window is automatically suspended (not deleted —
a tenant admin sees why and can resubmit) and stops being evaluated. This exists because
"provably bounded" is a claim about the validator, and the validator can have a bug; it is
not a substitute for §1, and this ADR says so explicitly rather than implying a timeout alone
would be sufficient. It would not be: Go has no safe primitive to preempt a goroutine
already executing, so a genuinely unbounded loop (one that escaped validation) would keep
consuming CPU even after this budget gives up waiting on it. The real safety property is
"the dialect cannot express that loop," never "we will notice and stop it in time."

**3. Fixture-gated activation, synchronous with the real interpreter.** A submission requires
one positive and one negative fixture — the exact same requirement `sigmac.LoadFixture`
already enforces for the compiled corpus, applied here at activation time instead of build
time, since this path has no build step to gate on. `sigmac.Evaluate` (the same reference
interpreter the compiler's own generated tests are checked against) runs the parsed rule
against both fixtures; a rule that doesn't match its own positive fixture, or does match its
own negative one, is rejected with the specific failure, never silently activated.

**4. Strict tenant isolation by construction, not by a new check.** A customer rule's
evaluation function receives exactly one already-flattened event and nothing else — no
database handle, no network access, the identical shape `sigmac.Evaluate` already has for
every platform and hotfix rule. An event reaching this worker was itself delivered by Kafka
as a single `events.normalized` record already scoped to one tenant; a rule is only ever
looked up and evaluated against that same tenant's own cached rule set, keyed by tenant ID.
There is no code path by which a customer rule is ever handed an event, or run against a
rule set, belonging to a different tenant — this is the same argument that already makes it
true for the existing in-stream and hotfix paths, extended to a third evaluator rather than
re-derived.

**5. A dedicated Kafka consumer group, decoupled from the compiled-corpus worker.** The
customer-rule worker consumes `events.normalized` under its own group (`detect-customer-
rules`), a second, independent read of the same topic. A slow or misbehaving customer rule
can only ever add latency within this worker's own poll loop — it shares no goroutine, no
poll cycle, and no consumer group with the worker evaluating the reviewed corpus and the
emergency hotfix path, so AC3's "cannot degrade platform performance for other tenants" is
true by construction for the platform's own compiled-rule latency SLO, not by a quota that
has to be tuned correctly.

**6. Never eligible for the P2-08 critical-alert bypass.** A customer rule's signal publishes
to `signals` exactly like any other, and is correlated and triaged exactly like any other —
but regardless of its own declared `level: critical`, it never publishes directly to
`alerts.critical`. That bypass is a guarantee specifically about rules that passed human
review before reaching production (TG4); a customer-authored rule has not, and claiming the
same guarantee for it would be dishonest about what TG4 actually promises.

## Alternatives considered

### A: Reuse the existing hotfix path (P2-12) for customer rules too

Appealing — it already exists, already uses `sigmac.Evaluate`, and already constrains
itself to in-stream rules. Rejected because it is the wrong trust boundary, not the wrong
mechanism: `hotfix_rules` has no `tenant_id` column and no RLS by design (0008_hotfix_rules.sql's
own comment — the cap is a single global count), reachable only by a platform-ops-tenant
admin. Giving every customer tenant write access to a platform-wide, ungoverned table
capped at 10 rows total would mean one tenant's rule exhausts every other tenant's
emergency-fix budget. The restricted-dialect validation and fixture-gating this ADR adds
would also need to be retrofitted onto hotfix rules, which exist specifically to bypass
friction during an incident — adding friction there defeats their purpose.

### B: Compile each customer rule to a WASM module, run on `wazero`

ADR-0004's own Alternative B, revisited for the actual problem this time (isolation, not
hot-reload). `wazero` is pure Go (no cgo), so it installs cleanly even in this project's
Windows dev environment, and it genuinely does provide preemptive termination — a real
answer to "Go cannot preempt a running goroutine." Rejected for this ticket specifically
because it solves a problem this restricted dialect does not have: WASM earns its isolation
cost when the guest code is Turing-complete and genuinely needs killing mid-flight. A
Sigma-subset interpreter walking a size-capped tree is not that; adding a WASM toolchain,
a compilation step per rule, and a new host/guest debugging story to sandbox something
that is already provably bounded is exactly the complexity ADR-0004's own Alternative B
rejection warned against, now for a one-to-three-engineer team that still has not grown. If
a future revision of this path allows a genuinely expressive, Turing-complete customer rule
language (arbitrary scripting, not a Sigma subset), this alternative should be revisited —
that is a different problem than the one this ADR solves.

### C: A subprocess per evaluation, killed by `cmd.Process.Kill()` on a context deadline

Genuinely preemptive (the OS can terminate a stuck process), no new dependency, portable to
this Windows dev sandbox. Rejected on cost for the same reason as B: it answers "how do we
kill something that might not terminate," and §1's complexity ceiling means nothing in this
dialect is expected not to terminate. Spawning a process per rule per event at detection-path
volumes (thousands of events/second) would also itself be a real latency and resource cost,
working against the very AC3 this ADR is trying to satisfy.

### D: Let tenants submit arbitrary Go plugins

Not seriously considered. Native code with no restricted dialect, no memory safety boundary
from the host process, no sandbox weaker than "don't."

## Consequences

### Good

- The validator rejects a pathological rule before it ever runs against a real event,
  rather than relying on catching it mid-execution
- No new third-party dependency, no new toolchain, no cgo — same Go stdlib `sigmac` package
  the rest of detection already depends on
- Reuses `sigmac.Parse`/`sigmac.Evaluate` exactly, so a customer rule and a platform rule
  can never silently disagree about what Sigma syntax means
- A slow or buggy customer rule is structurally isolated from the compiled corpus's own
  latency SLO by consumer-group separation, not by a shared-resource quota
- Fixture-gated activation reuses the exact mechanism (not just the idea) that already
  gates the reviewed corpus

### Bad

- The restricted dialect is a real capability cut relative to full Sigma — no windowed/
  aggregation rules, no rule bigger than the stated limits. A legitimate customer use case
  that needs either is out of scope for this path until a follow-up extends it
- The runtime timeout cannot actually kill a stuck goroutine if the complexity ceiling ever
  has a bug that lets an unbounded rule through — it can only stop re-evaluating that rule
  going forward, not reclaim the CPU already spent
- One more Kafka consumer group, one more Postgres polling loop, one more thing to monitor
- No dashboard authoring UI ships with this ADR — the sandbox and the API exist; a
  self-service rule editor is separate, additive scope

### Risks and how they are mitigated

| Risk | Mitigation | Owner |
|---|---|---|
| A validator bug lets an actually-unbounded rule through | §2's runtime budget auto-suspends a rule after 5 consecutive slow evaluations — bounds the damage window even though it cannot preempt the CPU already spent; the real fix is validator test coverage, which `validate_test.go` carries | Detection |
| A customer's 25-rule cap is reached legitimately and blocks a real new rule | The cap is a tenant's own ceiling, raised by support request, not a platform-wide constant tied to code | Detection |
| Customer-rule worker's own consumer group falls behind under many active tenants | Independent of the platform worker's own lag (separate group) — this worker's lag is a new, separate SLO, not a shared one, and alerts the same way `detect.consumer_lag` already does today for the platform worker | Platform |
| RE2 regex compilation cost, repeated per event per rule | Not yet cached in this first version — `interpret.go`'s own `matchOne` recompiles on every call for every rule, platform or customer; a known, disclosed inefficiency pre-existing this ADR, not introduced by it | Detection |

## Revisit when

A real customer use case needs a windowed (aggregating) rule, or a rule that genuinely
cannot fit the §1 limits — either should prompt scoping the windowed engine's own query
per-tenant (Alternative A's rejection already names the exact gap) rather than quietly
raising a limit until the dialect is Turing-complete again.
