# Contributing

## Branching

`main` is protected and always deployable. Work on `feat/<ticket>-<slug>`,
`fix/<ticket>-<slug>`, or `chore/<slug>`. Every branch traces to a board ticket.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/). Scope is the
package or service:

```
feat(ingest): add M365 management activity cursor checkpointing
fix(detect): correct impossible-travel velocity threshold
docs(adr): record ClickHouse partitioning decision
```

## Definition of Done

A ticket is done when **all** of these hold:

- [ ] Acceptance criteria on the issue are met
- [ ] Unit tests cover the new logic, including failure paths
- [ ] Integration tests pass against real containers (not mocks)
- [ ] For a detection rule: a positive **and** a negative fixture exist and pass
- [ ] `pnpm lint && pnpm typecheck && pnpm test` and `pnpm go:test` are green
- [ ] No secret, customer identifier, or live log sample is committed
- [ ] Docs or ADRs updated if behaviour or an interface changed
- [ ] PR reviewed and approved

"It works on my machine" is not evidence. Paste command output in the PR.

## Adding a detection rule

1. Write the Sigma rule in `detections/rules/<platform>/<id>.yml`
2. Map it to a MITRE ATT&CK technique — unmapped rules are rejected by CI
3. Add `detections/fixtures/<id>.positive.json` (must fire)
4. Add `detections/fixtures/<id>.negative.json` (must NOT fire)
5. Run `pnpm detections:validate`

A rule without a negative fixture is a false-positive generator. CI blocks it.
