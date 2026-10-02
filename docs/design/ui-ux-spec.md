# UI/UX Specification — "Control Room"

> Status: approved · Last updated: 2026-10-02 · Owner: Design
> Implemented by `packages/design-tokens` and `packages/ui`.

---

## 1. Who this is for, and when

Three people use this product, and two of them are not having a good day.

**The owner, at 02:18.** Woken by a phone. Non-technical. Needs to understand in one
sentence whether this matters and what tapping the button will do. Will never open the
dashboard on a laptop. Everything they need must survive being read half-asleep on a phone
in a dark room.

**The MSP analyst, 09:00–18:00.** Watching 200 client tenants. Dense information is a
feature, not a problem. Needs to triage fast, compare across clients, and never mistake
one tenant for another.

**The startup founder, occasionally.** Opens the dashboard when a customer's security
questionnaire asks for evidence. Needs to export something that looks credible.

Three contexts, one system. The resolution is a single visual language with two densities —
**comfortable** for the phone and the owner, **compact** for the console and the analyst —
sharing identical tokens.

---

## 2. Aesthetic direction

**Industrial-utilitarian. A darkened operations room at night.**

The reference is not a SaaS dashboard. It is an air traffic control desk, a ship's bridge, a
broadcast gallery: dark surfaces so that lit elements carry meaning, information at genuine
density, nothing decorative competing with the signal.

Three principles, and the rest follows from them:

**1 · Darkness is the canvas; light is information.** The interface is dark not as a style
choice but because a lit element in a dark field reads as *active*. When everything is
bright, nothing is urgent. Backgrounds are near-black with a blue cast; colour appears only
where something is true.

**2 · Evidence is the hero.** This product's one differentiator is that every claim is
provable. The UI must make proof feel *present* — the evidence link is never a footnote, and
the verified state has its own reserved colour used nowhere else in the system.

**3 · Calm under alarm.** A critical alert must feel serious without feeling panicked. No
flashing, no sirens, no red wash. Urgency is communicated through hierarchy, weight and
position — not through aggression. A product that screams gets muted, and a muted product is
the problem we are solving.

### What this explicitly is not

No purple-to-blue gradients. No glassmorphism. No neon cyberpunk "hacker" aesthetic — the
buyer is a 52-year-old who runs a logistics firm, not someone who wants to feel like they
are in a film. No pie charts. No dark theme that is merely a light theme with inverted
colours.

---

## 3. Typography

Three families, each doing a job the others cannot.

| Role | Family | Why |
|---|---|---|
| **Display** | Bricolage Grotesque | Variable width and optical size axes. Has real character at large sizes without being decorative. Used for page titles, severity headlines and large numerals only. |
| **Interface** | Archivo | A grotesque drawn for signage: slightly condensed, exceptionally legible at 12–14px, holds up at density. Carries the entire product UI. |
| **Evidence** | IBM Plex Mono | Unambiguous `0`/`O` and `1`/`l`/`I` — which genuinely matters when an operator is reading an IP address, an event ID or a hash at 2am. Used for all machine-generated values. |

The mono family is not a stylistic choice. Every value the system did not write in prose —
event IDs, addresses, technique IDs, timestamps, hostnames — is set in mono. The reader
learns within minutes that **monospace means machine fact**, and that is a signal worth
more than any amount of decoration.

### Scale

A 1.2 ratio, which stays tight enough for dense screens. Display sizes break the ratio
deliberately for impact.

| Token | Size / line-height | Family | Use |
|---|---|---|---|
| `display-xl` | 56 / 1.02 | Bricolage | Scan result headline, marketing |
| `display-l` | 38 / 1.08 | Bricolage | Page title |
| `display-m` | 27 / 1.15 | Bricolage | Case title, section headline |
| `body-l` | 17 / 1.55 | Archivo | The AI report — the one thing that is read as prose |
| `body-m` | 14 / 1.55 | Archivo | Default interface text |
| `body-s` | 13 / 1.45 | Archivo | Table cells, dense console |
| `label` | 11 / 1.2, +0.08em, uppercase | Archivo | Field labels, column headers |
| `mono-m` | 13 / 1.5 | Plex Mono | Event values, identifiers |
| `mono-s` | 11.5 / 1.45 | Plex Mono | Inline evidence references |

The AI report gets `body-l` at 17px with a 68-character measure. It is the only genuinely
*readable* text in the product and it is treated like editorial body copy, because the
owner's comprehension of that paragraph is the entire product experience.

---

## 4. Colour

### Surfaces

Four layers of near-black with a blue cast. Depth comes from layering and hairline borders,
never from shadow on dark surfaces.

| Token | Value | Use |
|---|---|---|
| `bg-void` | `#070A11` | Page background |
| `bg-surface` | `#0C111C` | Cards, panels |
| `bg-raised` | `#131A28` | Elevated surfaces, hover |
| `bg-sunken` | `#04060B` | Evidence wells, code blocks, inputs |
| `border-hairline` | `#FFFFFF` @ 8% | Default separation |
| `border-strong` | `#FFFFFF` @ 16% | Emphasised separation, focus ring base |

### Text

| Token | Value | Contrast on `bg-surface` |
|---|---|---|
| `text-primary` | `#E8ECF4` | 15.9:1 |
| `text-secondary` | `#9BA6BA` | 7.7:1 |
| `text-tertiary` | `#7A849A` | 4.6:1 |
| `text-disabled` | `#3C465C` | 2.6:1 — non-text use only |

### Severity — the colour-blind-safe ramp

Conventional security palettes run green → yellow → red. Under deuteranopia and protanopia —
roughly 8% of men — that ramp collapses into a band of indistinguishable yellows. For a
product whose single most important signal is *how bad is this*, that is a defect.

This ramp runs along a **blue → magenta** axis instead, because blue/yellow discrimination
survives both common forms of colour blindness, and it carries a strong lightness gradient so
the ordering holds even in full greyscale.

| Severity | Token | Value | Icon | Greyscale L* |
|---|---|---|---|---|
| Critical | `sev-critical` | `#FF3D6E` | filled octagon | 58 |
| High | `sev-high` | `#FF8A3D` | filled triangle | 71 |
| Medium | `sev-medium` | `#F5C544` | filled diamond | 82 |
| Low | `sev-low` | `#3DBFF2` | filled circle | 74 |
| Info | `sev-info` | `#777F8F` | hollow circle | 54 |

**The binding rule: severity is never communicated by colour alone.** Every severity
indicator carries all three of hue, a distinct icon shape, and a text label. This is enforced
by the component API — the severity component takes a severity token and renders all three;
there is no prop that renders only the colour. A lint rule and a unit test both check it.

### Accents — used sparingly, which is what makes them work

| Token | Value | Reserved for |
|---|---|---|
| `signal` | `#34D1F0` | Live/active state, focus rings, the "watching" indicator. Nothing else. |
| `verified` | `#4ADE9B` | **Grounded evidence only.** |

`verified` green appears nowhere else in the product. Not for success toasts, not for healthy
connectors, not for passing checks. It means exactly one thing: *this claim was re-queried
against the event store and the event exists*. Reserving a colour for the product's central
promise makes that promise visible at a glance and makes its absence conspicuous.

### Light theme

A full light theme exists and meets the same AA requirements. It is not the default and is
not expected to be heavily used — it exists for printed reports, bright-office MSP floors,
and users who need it. Severity hues shift in lightness, never in hue, so the learned
colour-to-meaning mapping survives the switch.

---

## 5. Space, density and layout

4px base unit. Two density modes sharing one token set.

| | Comfortable (owner, phone) | Compact (analyst, console) |
|---|---|---|
| Row height | 56px | 36px |
| Section gap | 32px | 20px |
| Card padding | 24px | 16px |
| Base type | `body-m` 14px | `body-s` 13px |

Density is a user preference, persisted, defaulting from viewport width. The MSP console
defaults to compact regardless, because 200 clients at comfortable density is a scrolling
exercise rather than a monitoring surface.

**Layout grammar.** Case-centric screens use an asymmetric two-column split — a 62/38
narrative-to-evidence ratio — rather than a centred column. The narrative reads left, the
proof sits right, and the relationship between them is spatial rather than something the user
has to hunt for. Below 1024px the evidence column collapses beneath each claim as a
disclosure.

---

## 6. The components that carry the product

Most of the component library is unremarkable, and should be. Four are not.

### 6.1 Evidence disclosure

The most important component in the system. Each claim in an AI report is followed by a
`verified` marker and a count of supporting events. Activating it expands a `bg-sunken` well
containing the raw events in mono, with the matched fields highlighted.

- Default is **collapsed** — the owner should not have to read logs
- Always **present** — the analyst must never have to go looking
- Expansion is instant for cached evidence; a skeleton shows for a cold-tier fetch
- An unresolvable reference renders an explicit failure state, never a silent omission

That last point is the whole design. If grounding fails, the UI says so loudly. A product
that quietly drops its proof is worse than one that never claimed to have any.

### 6.2 Severity indicator

Hue plus icon plus label, always all three. There is no colour-only variant and the API does
not permit one.

### 6.3 Approval control

The highest-stakes interaction in the product: a half-asleep person about to disable an
employee's account.

- States the action in plain language: "Lock Priya's account and sign her out everywhere"
- States the blast radius before, not after: "Affects 1 person. Reversible in 1 tap."
- Destructive actions require a deliberate confirmation — never a single tap that cannot be
  taken back
- The Approve control and the Call Me First control are visually equal in weight; we are
  not nudging anyone into an irreversible action at 2am
- Post-action, the control is replaced by its outcome and the reversal route, not by a toast
  that disappears

### 6.4 Live indicator

A slow 3-second pulse on the `signal` accent, present whenever ingest is healthy. It is the
only persistent animation in the product. Its job is to make "we are watching" continuously
true rather than something stated once on a marketing page. When ingest degrades, the pulse
stops and the state changes — absence of motion carries the bad news, which is quieter and
more credible than an alarm.

---

## 7. Motion

Restraint is the policy. Frivolous motion in a security product reads as unserious, and this
product is asking to be trusted with the thing the customer is most afraid of.

| Token | Duration | Easing | Use |
|---|---|---|---|
| `motion-instant` | 80ms | ease-out | Hover, focus |
| `motion-quick` | 160ms | cubic-bezier(.2,.8,.2,1) | Disclosure, tabs |
| `motion-considered` | 280ms | cubic-bezier(.16,1,.3,1) | Panels, dialogs |
| `motion-pulse` | 3000ms | ease-in-out, infinite | Live indicator only |

New cases enter a list with a 40ms staggered fade — enough to show that something arrived,
not enough to be a performance. Nothing in the product bounces, springs or slides in from
off-screen.

`prefers-reduced-motion` removes all of it including the live pulse, which is replaced by a
static state dot. The reduced-motion path is tested, not assumed.

---

## 8. Accessibility

Non-negotiable, and a competitive advantage in enterprise procurement.

- **WCAG 2.1 AA** across every surface, verified by automated checks in CI
- **Severity never by colour alone** — enforced at the component API, not by convention
- **Full keyboard operation** of every workflow including approval. An analyst who lives in
  this console all day should rarely need the mouse
- **Visible focus** at 2px `signal` with a 2px offset — never removed, including on mouse
  interaction
- **Screen reader**: cases are articles, severity is announced before the title, evidence
  disclosures announce their expanded state and event count
- **Target size** minimum 44×44px on touch, which drives the comfortable density
- **Tested with simulation** for deuteranopia, protanopia and tritanopia on every severity
  surface before release

---

## 9. Voice

The interface writes the way the product promises to: plainly.

| Do | Don't |
|---|---|
| "Someone in Russia opened Priya's email and is secretly copying her messages." | "Anomalous authentication event detected with suspicious mailbox rule creation." |
| "Lock the account and sign her out everywhere" | "Execute remediation playbook" |
| "We checked 47,000 records today. 3 needed your attention." | "47,000 events processed. 3 alerts generated." |
| "Nothing serious this week." | Manufactured urgency to justify the subscription |

Any technical term that must appear is glossed inline on first use. MITRE technique IDs are
always accompanied by their plain-English meaning. A readability check gates the generated
report copy in CI.

The last row matters most commercially. A security product that invents urgency to prove its
worth trains its customers to stop believing it — which is precisely how the incumbent tools
ended up muted.

---

## 10. Implementation

- Tokens are defined once in `packages/design-tokens` and emitted as CSS custom properties,
  a Tailwind v4 theme, and typed TypeScript constants. There is no second source.
- `packages/ui` builds on Radix primitives for correct keyboard and ARIA behaviour.
- A lint rule rejects any hardcoded colour value inside `packages/ui` and `apps/dashboard`.
- A CI test asserts AA contrast across every defined foreground/background pairing.
- A CI test asserts every severity token has a distinct icon and label.
