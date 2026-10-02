# Build cache

Turborepo caches task output so that work already done is not done again. There are
two tiers: a local cache in `.turbo/`, on by default and requiring no configuration,
and a Remote Cache shared between machines and CI.

Remote caching is **configured but disabled by default** — see `remoteCache` in
[`turbo.json`](../turbo.json). The configuration is committed so that enabling it is a
credential change rather than a schema change, and so that a reader can see what the
settings would be without reconstructing them.

## Why it is off by default

A shared cache is a supply-chain surface. Any party who can write to it can serve a
poisoned artifact to every later build, including CI. Turning it on is therefore a
deliberate decision with an owner, not a default a clone inherits. Until the repo has
a cache with access control we can point at, local caching alone is enough: the full
check suite completes in well under a minute from warm.

Local caching is unaffected by this setting. `turbo` will still replay cached logs on
an unchanged package — that is what `FULL TURBO` in the output means.

## Enabling it

`remoteCache.enabled` defaults to `true` in Turborepo; this repo sets it to `false`,
which disables all remote cache operations *even when a valid token is present*. So
enabling remote caching takes two steps, not one.

**1. Flip the switch** in `turbo.json`:

```jsonc
{
  "remoteCache": {
    "enabled": true,
    "timeout": 30,
    "uploadTimeout": 60
  }
}
```

**2. Provide credentials.** For a managed cache, `turbo login` then `turbo link`.
For CI, or for any non-interactive machine, use environment variables instead:

| Variable | Meaning |
|---|---|
| `TURBO_TOKEN` | Bearer token used to authenticate against the cache |
| `TURBO_TEAM` | Account/team **slug** associated with the repository |
| `TURBO_TEAMID` | Account/team **identifier**; with a managed cache this is the team ID |
| `TURBO_API` | Base URL of the cache. Required when self-hosting |
| `TURBO_REMOTE_CACHE_READ_ONLY` | Read from the cache but never write to it |

In GitHub Actions, `TURBO_TOKEN` belongs in repository secrets and `TURBO_TEAM` in
repository variables. Do not add either to `globalEnv` in `turbo.json`: `globalEnv`
feeds the task hash, so a rotated token would invalidate every cache entry in the
repo. Turborepo reads these variables natively.

### Self-hosting

A self-hosted cache needs the API URL, team and token supplied directly — either
through the variables above or with `turbo run ... --manual`, which takes them as
flags. `remoteCache.apiUrl` and `remoteCache.loginUrl` both default to
`https://vercel.com` and must be overridden to point elsewhere. Note that
`remoteCache.teamId` is ignored unless the value begins with `team_`.

### Restrict CI to read-only

Pull-request builds run code from outside the trust boundary. Give those runs
`TURBO_REMOTE_CACHE_READ_ONLY=1` so a fork cannot write an artifact that a later
trusted build would consume. Only builds on `main` should populate the cache.

## Artifact signing

With `remoteCache.signature: true`, Turborepo signs every uploaded artifact with
`HMAC-SHA256` using `TURBO_REMOTE_CACHE_SIGNATURE_KEY`, and rejects any downloaded
artifact whose signature is absent or invalid.

Read what this does and does not give you. Turborepo's own documentation is explicit
that it is an **integrity** check, not a security control — it defends against a
partial upload or a corrupt cache server, not against an attacker who holds the
signing key. It is not a substitute for access control on the cache itself.

If you enable it, also set `futureFlags.longerSignatureKey: true`, which enforces a
minimum key length of 32 bytes. HMAC-SHA256 accepts any key length, so without the
flag a short key is accepted silently while making brute-force tag collision
feasible. Short keys are rejected in a future major version regardless.

```jsonc
{
  "futureFlags": { "longerSignatureKey": true },
  "remoteCache": { "enabled": true, "signature": true }
}
```

## Reference

The authoritative reference is the documentation bundled with the installed `turbo`
package, which matches the version in the lockfile and is available offline:

```bash
node -p "require.resolve('turbo/package.json')"   # then read ../docs/
```

Start at `docs/reference/configuration.mdx` (the `remoteCache` fields) and
`docs/core-concepts/remote-caching.mdx`. Prefer those over the website, whose content
tracks the latest release rather than ours.
