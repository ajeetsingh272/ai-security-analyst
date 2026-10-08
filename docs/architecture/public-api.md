# Sentinel Public API (P6-09)

A documented, versioned HTTP API so an MSP can integrate Sentinel's case
and report data into their own tooling (PSA, ticketing, BI). Separate
from the dashboard's own internal API (cookie-based session) — this
surface is authenticated by API key and is the only part of this
service with a published compatibility contract.

## Authentication

Every request must carry:

```
x-api-key: sk_live_...
```

A key is created from the dashboard (`POST /api-keys`, admin role
required) and shown in full exactly once, at creation — only its SHA-256
hash is ever stored afterward, the same principle as a password hash,
though a fast hash (not a slow KDF) is the correct choice here since the
key itself is already a high-entropy random secret, not a human-chosen
one. There is no way to recover a lost key; revoke it and create a new
one.

A key is scoped to exactly one tenant, decided once at creation from
the admin session that created it — never from anything the request
itself claims. Every `/v1/*` request re-derives its tenant from a fresh
database lookup of the key's own hash, and from there the same
row-level-security mechanism that scopes every other tenant-owned table
in this schema applies identically; nothing about the public API
surface weakens that isolation.

### Permissions (scopes)

A key is created with one or more scopes:

| Scope | Grants |
|---|---|
| `read` | Read-only access (the default) |
| `write` | Everything `read` grants, plus anything a v1 endpoint marks as requiring it |

`/v1` ships entirely read-only endpoints as of v1.0.0 — `write` exists
in the data model and is already enforced wherever a future endpoint
needs it, but nothing in v1 currently requires it. This is a deliberate,
disclosed scope boundary, not an oversight: see "Versioning" below for
how a write endpoint would be added later without breaking v1 itself.

## Rate limiting

**60 requests per minute, per API key** (a fixed one-minute window, not
a sliding one). Every response carries:

```
RateLimit-Limit: 60
RateLimit-Remaining: 47
RateLimit-Reset: 23
```

A request over the limit gets `429 Too Many Requests` with a
`Retry-After` header (seconds) and `{"error": "rate_limited",
"retryAfterSeconds": 23}`.

## Endpoints (v1)

| Method | Path | Scope | Description |
|---|---|---|---|
| GET | `/v1/cases` | `read` | List cases, filterable by severity/state/date range, paginated |
| GET | `/v1/cases/{id}` | `read` | Get a single case |
| GET | `/v1/reports/weekly` | `read` | List this tenant's weekly owner reports, most recent first |

The full machine-readable contract is generated — never hand-written —
from the same Fastify JSON Schema each route already validates its own
requests/responses against (`apps/api/src/openapi.ts`,
`apps/api/src/routes/v1/*.ts`); it cannot drift from actual behaviour
the way a separately-authored document could, and
`apps/api/src/__tests__/openapi-spec.integration.test.ts` proves real
responses validate against it, not just that it exists.

## Versioning and deprecation policy

- The version is in the URL path (`/v1/...`). There is no header-based
  or query-string versioning.
- **Within a version**, only backward-compatible changes are made:
  a new optional request field, a new response field, a new endpoint,
  a new optional scope. An existing client ignoring fields it doesn't
  recognise continues to work without any change on its part.
- **A breaking change** (removing/renaming a field, changing a type,
  tightening a previously-optional request field to required, removing
  an endpoint) ships as a new version prefix (`/v2/...`) rather than
  changed in place under `/v1`. This mirrors the same
  PATCH/MINOR/MAJOR discipline `packages/schema`'s own
  `scripts/check-compatibility.mjs` already enforces for the internal
  Case contract (P3-08) — the same judgment call, applied to the public
  surface instead of the Go codegen one.
- **Deprecation**: once a new version ships, the previous one remains
  fully supported for a minimum of 6 months. During that window every
  response from the deprecated version carries a `Sunset` header (RFC
  8594, the date support ends) and `Deprecation: true`. No version is
  ever removed without that notice period having actually elapsed.
- There is nothing to deprecate yet — v1 is the only version that
  exists. This section documents the process that will be followed
  when that changes, not a mechanism retrofitted onto endpoints that
  don't need it yet.

## Defense in depth

A key's tenant scope is enforced twice, independently:

1. **At the auth layer** — `/v1/*` never trusts a tenant id the request
   claims; it is looked up fresh, every request, from the key's own
   hash against the database (`findApiKeyByHash`).
2. **At the database layer** — every query made on the key's behalf
   goes through the exact same `TenantScopedRepository` + Postgres
   row-level-security mechanism (`FORCE ROW LEVEL SECURITY`) that scopes
   every dashboard request. A bug in (1) that somehow resolved the
   wrong tenant would still be caught by (2), and vice versa.
