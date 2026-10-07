# Runbook: signal-to-case reduction ratio degraded

**Alert:** `Signal-to-case reduction ratio dropped below 8:1`
(`infra/docker/grafana-provisioning/alerting/reduction-ratio.yml`, uid
`p3-06-reduction-ratio-below-8to1`)

**Guarantee at risk:** TG3 — "Nothing is hidden." This measurement counts every
signal that reached `case_signals` (`services/correlate/internal/reduction`),
including suppressed ones (P2-10 already keeps those stored and counted, just
not escalated) — the ratio is not allowed to look healthy by quietly excluding
a category of signal from the denominator. If you are tempted to "fix" this
alert by narrowing what counts as a signal, stop and read
[`SECURITY.md`](../../SECURITY.md) first: that is the guarantee this ticket
exists to protect, and weakening it needs an ADR and two reviewers.

## What this means

The product's own unit economics depend on turning a high volume of raw
signals into a small number of cases worth a human's or the LLM's attention
(target >= 10:1, see `docs/architecture/overview.md` §3.6). A ratio below 8:1
for a tenant means one of two things, and they require opposite responses:

1. **A detection rule got noisy** — it is escalating cases it should not be,
   or clustering is failing to collapse signals that belong together. This is
   the expected, common cause.
2. **Scoring or clustering itself regressed** — a bug lowered the escalation
   threshold's effective bar, or broke the sliding-window join
   (`services/correlate/internal/cluster`), so signals that used to join one
   case now open many.

## Diagnose

1. **Identify the tenant(s) and day.** The alert's own `tenant_id` label
   names the tenant; the Promethees query evaluates `correlate_reduction_ratio`,
   which reflects that tenant's own most recently completed calendar day
   (`cmd/correlate/main.go`'s `runReductionRatioSweep`).
2. **Pull the real counts, not just the ratio** — the ratio alone cannot tell
   you whether signals_in spiked or cases_escalated did:
   ```sql
   -- against ClickHouse
   SELECT day, signals, cases_escalated, ratio
   FROM sentinel.daily_reduction
   WHERE tenant_id = '<tenant-uuid>'
   ORDER BY day DESC
   LIMIT 14;
   ```
3. **If `cases_escalated` rose while `signals` stayed flat**: a scoring or
   threshold regression is the likely cause. Check
   `services/correlate/internal/scoring`'s `EscalationThreshold` for that
   tenant's own plan tier, and whether a recent deploy changed `Score`'s own
   component weights.
4. **If `signals` itself spiked**: find which rule(s) are driving it —
   ```sql
   SELECT rule_id, count(*) FROM case_signals
   WHERE tenant_id = '<tenant-uuid>' AND detected_at::date = '<day>'
   GROUP BY rule_id ORDER BY count(*) DESC LIMIT 10;
   ```
   A single rule dominating the count is the classic "noisy rule" shape
   (the T2 test case this ticket's own test suite covers directly).
5. **If a case's own escalated count looks right but the ratio still looks
   wrong**: check whether clustering itself is failing to join signals that
   should share a case — `services/correlate/internal/cluster`'s own sliding
   window (`DefaultWindow`, 60 minutes) may be too short for this tenant's
   real signal cadence, or an entity-identifier mismatch is splitting what
   should be one entity into several.

## Mitigate

- **Noisy rule identified**: suppress it (P2-10's own suppression mechanism)
  or tune its condition, then re-run the backfill for the affected day(s) to
  confirm the ratio recovers:
  ```
  go run ./services/correlate/cmd/backfill-reduction \
    -tenant=<tenant-uuid> -from=<day> -to=<day>
  ```
- **Scoring/threshold regression identified**: this is a product incident —
  file one per the standard incident process, since customers were very
  likely notified of cases that should have been triaged away automatically.
  Roll back the regressing change; do not hotfix the threshold itself without
  review (two reviewers, per TG3's own flag on this ticket).
- **Clustering regression identified**: same incident process. This is the
  more serious failure mode — it means noise is reaching customers that
  should never have escalated at all.

## Document as a product incident

AC5 requires this: any genuine degradation (not a single noisy rule caught
and suppressed within the same day) is written up as a product incident —
what regressed, which tenants were affected, how many extra cases customers
saw that should have been reduced away, and the fix. Link the incident here
once filed.
