## What and why

<!-- Closes #<issue>. Describe the change and the reason for it. -->

Closes #

## Evidence

<!-- Paste real command output. "It works on my machine" is not evidence. -->

```
$ pnpm lint && pnpm typecheck && pnpm test

$ go vet ./... && go test -race ./...

```

## Definition of Done

- [ ] Every acceptance criterion on the issue is met
- [ ] Every test case on the issue exists and passes
- [ ] Unit tests cover the new logic, including failure paths
- [ ] Integration tests pass against real containers, not mocks
- [ ] For a detection rule: positive **and** negative fixtures exist and pass
- [ ] No secret, customer identifier or live log sample is committed
- [ ] Docs or ADRs updated if behaviour or an interface changed

## Trust guarantees

- [ ] This change does not weaken any guarantee in `SECURITY.md`
- [ ] If it does, an ADR is linked and a second reviewer is assigned

## Rollback

<!-- How is this reverted if it misbehaves in production? -->
