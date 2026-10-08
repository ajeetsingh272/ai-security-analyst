# End-to-end self-serve onboarding test (P6-13)

`apps/dashboard/e2e/self-serve-onboarding.spec.ts` — the P6 exit
criterion as an automated test: signup to connector to scan to first
case to weekly report, unassisted. Runs on every push/PR (as part of
`ci-e2e.yml`'s full Playwright suite) and nightly on its own schedule
(`.github/workflows/self-serve-onboarding-nightly.yml`).

## The one requirement this sandbox genuinely cannot satisfy

**"Runs against a real Microsoft test tenant, not a mock."** There is
no real Entra app registration, real Microsoft test-tenant
credentials, or network path to `login.microsoftonline.com` anywhere
in this environment — the same gap every other M365-related test in
this repo already discloses (`m365-connector.integration.test.ts`,
`connectors.spec.ts`, P6-12's `onboarding-funnel.integration.test.ts`).
This is not a "close enough" substitute decision; it is a flat
inability to engineer around a missing external credential and
service, disclosed prominently rather than quietly worked around.

**What this means in practice**: this test (and its nightly run) gates
on every real signal the sandboxed stack CAN provide — a regression in
sign-in, the connectors page, the free-scan trigger, or weekly-report
generation. It does **not** gate on a real Microsoft-side regression,
since no real Microsoft integration is exercised at all. Running the
literal AC — the real thing, against an actual Entra app registration,
on a real schedule — is a separate, not-yet-done follow-up this test
does not substitute for, and whoever reviews this work should treat
"runs against a real Microsoft tenant" as **not met** by it.

## What the test seeds directly, and why

Two steps are seeded rather than produced by the system end-to-end,
each for its own already-established reason:

- **The connector's "connected" state** — mirrors `connectors.spec.ts`'s
  own established precedent (`seedConnector`): driving a real
  Microsoft OAuth consent screen needs the real Entra app registration
  this whole gap is about.
- **The tenant's first case** — real signal ingestion needs the
  ClickHouse-backed pipeline, which cannot run in this sandbox (blocked
  S3/MinIO dependency — the same gap every ClickHouse-touching P6
  ticket this phase already hit). Seeding one case directly stands in
  for "detection already happened," giving the scan and the weekly
  report something real to summarise.

Everything else — sign-in, navigating to `/connectors`, triggering a
real `POST /scan`, viewing the real scan report, triggering a real
`POST /reports/weekly`, and viewing the real generated report — is a
genuine HTTP round trip against the real dev stack, nothing stubbed at
the browser layer.

## Wall-clock bound (T1)

The test measures real elapsed wall-clock time from the first sign-in
to the weekly report becoming visible, and asserts it stays under 15
minutes. This is trivially satisfied here — nothing in this sandboxed
path has a real external wait to make it otherwise. The real
production bottleneck this bound is meant to catch (Microsoft's own
activity-feed propagation delay before any detection can happen at
all) is not reproducible without the real Microsoft tenant disclosed
above as unavailable.

## Failure attribution (T3)

Each step of the journey runs through a small `runStep(name, fn)`
helper that rethrows any failure as `Step "<name>" failed: <original
message>` — a nightly failure names which part of the path broke
without a human reading the test source first. A dedicated test
deliberately breaks the scan step (navigating to a scan id that was
never created) and asserts the resulting error is attributed to that
exact step, proving the mechanism works.
