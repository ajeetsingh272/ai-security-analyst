# @sentinel/ui

Shared React components built on `@sentinel/design-tokens`. Every colour in this
package comes from a Tailwind utility backed by a token; a lint rule
(`control-room/no-hardcoded-hex` in the root `eslint.config.js`, scoped to
`packages/ui/src/**`) rejects a raw hex value anywhere in here.

A consuming app must load `@sentinel/design-tokens/theme.css` (which in turn
imports the generated token custom properties) and run its own Tailwind v4
build against `@sentinel/design-tokens/tailwind.css` for the utility classes
below to resolve to anything. No app in this repo has wired up that Tailwind
build yet — tracked as a known gap below rather than silently assumed to work.

## Button

```tsx
import { Button } from '@sentinel/ui';

<Button variant="primary" onClick={handleApprove}>
  Approve action
</Button>

<Button variant="danger" isLoading={isRevoking}>
  Revoke session
</Button>

{/* Renders the child, with Button's classes and disabled/aria state merged on */}
<Button asChild>
  <Link href="/cases/1">Open case</Link>
</Button>
```

| Prop | Type | Default | Notes |
|---|---|---|---|
| `variant` | `'primary' \| 'secondary' \| 'ghost' \| 'danger'` | `'secondary'` | `danger` uses the critical severity hue — reserve it for destructive actions, not for "this is bad news" (that's `ErrorState`). |
| `size` | `'sm' \| 'md'` | `'md'` | |
| `asChild` | `boolean` | `false` | Forwards `children` through Radix's `Slot`. Composes with exactly one child element — not with `leadingIcon` or `isLoading`, which require owning the markup. |
| `isLoading` | `boolean` | `false` | Disables the control for real (not just visually) so a second click cannot fire mid-request, and sets `aria-busy`. |
| `leadingIcon` | `ReactNode` | — | Ignored while `isLoading` is true. |

## Badge

```tsx
import { Badge } from '@sentinel/ui';

<Badge>trial</Badge>
<Badge variant="verified">grounded</Badge>
```

`variant="verified"` is reserved for TG1 — a claim that was re-queried against
the event store and the referenced event exists. Nothing else in the product
should pass this variant; that discipline lives at the call site.

## SeverityPill

```tsx
import { SeverityPill } from '@sentinel/ui';

<SeverityPill severity="critical" />
<SeverityPill severity="low" compact />   {/* icon + colour only; label still in the a11y tree */}
```

Severity is always hue + icon + label together — there is no variant that
renders hue alone, by design (see `@sentinel/design-tokens`'s `severity` ramp).
`compact` hides the label visually for dense table rows; it stays in the
accessibility tree via `sr-only` rather than disappearing for screen reader
users.

## Card

```tsx
import { Card } from '@sentinel/ui';

{/* static container */}
<Card>{caseSum}</Card>

{/* interactive: gets role="button", tabIndex, and Enter/Space activation */}
<Card onClick={() => openCase(id)}>{caseSummary}</Card>
```

Passing `onClick` is what makes a `Card` interactive — and that switch carries
full keyboard semantics with it. A clickable `<div>` that only a mouse can
reach is the single most common accessibility regression in dashboard UI; this
is handled once, here, rather than at every call site that wants a clickable
row.

## Skeleton / EmptyState / ErrorState — the loading/empty/error triad

Every data-bearing view renders one of these three instead of its real content
while a request is pending, empty, or failed.

```tsx
import { Skeleton, EmptyState, ErrorState } from '@sentinel/ui';

if (isLoading) return <Skeleton lines={5} />;
if (error) return <ErrorState title="Could not load cases" onRetry={refetch} />;
if (cases.length === 0) return <EmptyState title="No open cases" description="You're all caught up." />;
return <CaseList cases={cases} />;
```

`ErrorState` renders `role="alert"` and the critical severity colour —
distinct from `EmptyState`, which is calm by design: zero open cases is a good
outcome for a security product, not a problem to apologise for.

## Testing

```bash
pnpm --filter @sentinel/ui test   # component, keyboard, axe assertions
pnpm lint                         # root-level; catches hardcoded hex via control-room/no-hardcoded-hex
```

`src/__tests__/themes.ts` is the shared harness for "renders in both themes" —
toggling `data-theme` on `document.documentElement` the same way an app would.
Full computed-style verification (does `bg-signal` actually paint the right
pixel) needs a real Tailwind v4 build, which no app in this monorepo has wired
up yet; these tests verify structural and ARIA equivalence across both theme
states instead, which is what's genuinely checkable without one.
