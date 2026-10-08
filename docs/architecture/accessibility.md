# Accessibility (P6-11, WCAG 2.1 AA)

## Automated coverage

- **Component-library level** (`packages/ui/src/__tests__/axe.test.tsx`,
  `app-shell-axe.test.tsx`, `keyboard.test.tsx`, `severity-color-
  independence.test.tsx`, pre-existing from P0-08/P6-01): every
  primitive, a composed shell, tab order/focus-visibility, and an
  explicit non-color-channel guarantee for `SeverityPill`.
- **Per-screen, jsdom level** (`apps/dashboard/src/components/
  __tests__/*.test.tsx`): a real axe-core scan of every dashboard
  client component in its populated state, in both themes
  (`src/test-utils/axe.ts`'s shared `forEachTheme`/
  `expectNoAxeViolations` harness).
- **Per-route, real-browser level** (`apps/dashboard/e2e/
  accessibility.spec.ts`): `@axe-core/playwright` against actual
  painted Chromium pixels for every authenticated route — this is
  where colour-contrast is a REAL pass/fail, not the jsdom-level
  "incomplete, environment-limited" result the unit tests carve out
  (axe needs real layout/paint for that specific rule).
- **CI gate** (AC5): unit-level axe already ran inside `pnpm test:unit`
  (`ci-typescript.yml`); `.github/workflows/ci-e2e.yml` (new) runs the
  full Playwright suite, including the axe scan and the keyboard-only
  approval workflow, against the real dev stack, gating every PR.

## Honestly substituted manual test cases

Two of this ticket's own test cases are explicitly manual and require
a human:

- **T2 ("screen reader walkthrough of the case review and approval
  path")** — no real screen reader software or human auditory
  judgement exists in this environment. The substitute
  (`accessibility.spec.ts`'s own "screen-reader-tree proxy" describe
  block) captures a real ARIA accessibility-tree snapshot of the exact
  same path and asserts the roles/names a screen reader actually reads
  from are present and sensible (a real heading for the case title, an
  unambiguously-named Approve button). This proves the underlying
  accessibility TREE is correct — the thing a screen reader reads from
  — but a human walkthrough recording should still happen before this
  ships to real users.
- **T3 ("colour-blindness simulation review of every severity
  surface")** — no human visual judgement of a simulated screenshot
  exists here either. The substitute
  (`packages/ui/src/__tests__/severity-color-independence.test.tsx`)
  proves the actual WCAG 1.4.1 guarantee programmatically: every
  severity level has both a unique icon shape and a unique text label
  (present in the accessible name even in `compact` mode, where it's
  visually hidden but not removed), and the icon is marked decorative
  so the label is the one source of truth for the accessible name.
  Colour-contrast itself is covered separately by the axe scans above
  and by `packages/design-tokens`'s own 73-test contrast suite.

Neither substitute claims to BE the manual review; both make the
specific thing a human reviewer would check verifiable and repeatable
in the meantime.

## Real bugs found and fixed by this audit

1. **Six pages had no level-one heading in one or more states**
   (`CaseList`, `ConnectorsWizard`, `ScanReport`, `WeeklyReportView`,
   `SuppressionList`, `MspConsole`, `CaseDetail`) — several had their
   `<h1>` only in the final "loaded with data" branch, so a tenant
   with no linked clients, no suppressions, or a slow/failed request
   saw a page with no heading at all. Fixed by hoisting the heading
   (or, for `CaseDetail`, a generic fallback heading until the real
   title loads) above every early return.
2. **A keyboard-specific navigation dead end in `CaseList`**: the
   expanded row's "View full case" link sits inside the row's own
   interactive `Card`. A mouse click already stopped propagation on
   the link's `onClick` so the Card's own click handler never fired —
   but nothing stopped the link's `onKeyDown` from bubbling to the
   Card, whose own Enter/Space handling then fired too, calling
   `preventDefault()` (cancelling the link's navigation) and toggling
   the row back to collapsed. A keyboard user tabbing to that link and
   pressing Enter silently failed to navigate at all; the identical
   mouse-click path always worked. Fixed by stopping propagation on
   the link's `onKeyDown` too.
3. **Error messages in `CaseDetail`'s approve and challenge-dismissal
   controls had no `role="alert"`** — a failed approval or challenge
   attempt was visually shown but never announced to a screen reader.
   Fixed to match `ErrorState`'s own existing `role="alert"`
   convention.

## Known, disclosed gaps (not fixed in this ticket)

- No automated check runs `aria-valid-attr-value`/landmark checks
  against `/settings`'s real content, since that page has no real
  settings UI yet (a later ticket, per P6-01) — only its placeholder
  `EmptyState`/`ErrorState` output is covered here.
