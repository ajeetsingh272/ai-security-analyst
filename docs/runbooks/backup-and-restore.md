# Runbook: Postgres and ClickHouse backup, restore, and disaster recovery

**Risk this addresses:** P7-09's own framing — "A backup that has never been restored is
not a backup." Before this ticket, neither store had any backup mechanism at all; this
runbook, and the scripts it documents, are the first time either has been exercised for
real, not merely assumed to work from `pg_dump --help`/ClickHouse's own docs.

**Guarantee at risk:** every tenant's own case history, audit trail, and raw event data
exist in exactly two places — the live Postgres and ClickHouse the product reads and writes
every day. A failure that destroys either (storage corruption, an operator error, the
underlying cloud volume itself failing) with no tested restore path is total, permanent
data loss for every tenant on the platform, not a recoverable incident.

## RPO and RTO, stated and justified

| Store | RPO | RTO (production target) | Justification |
|---|---|---|---|
| Postgres (control plane) | 24 hours | 30 minutes | Daily backup cadence matches the existing, already-proven-reliable `verify-audit-chain.yml` daily cron (ADR-0007) — the same operational rhythm this team already runs successfully, not a new one invented for this ticket. RTO: a real, measured restore against this session's own dev-stack data (49 tenants, 10,551 audit rows, 627 users, 16 cases) completed in **43 seconds**, of which the fixed schema-migration step (constant regardless of data volume — see Procedure step 2) is the dominant cost. Postgres holds "thousands to millions of rows" at the stated 10,000-tenant target (ADR-0008), not the per-event volume ClickHouse does — `pg_restore`'s own COPY throughput comfortably clears that volume inside 30 minutes. **Not yet measured at production scale** — disclosed, not assumed. |
| ClickHouse (event store) | 24 hours | 4 hours | Same daily cadence. RTO is a reasoned extrapolation, explicitly NOT a direct measurement: this session's own real restore (159 events) completed in well under a second, which says nothing about restoring ADR-0005's own stated production scale (~4.5 TB hot, 90 days of ~500M events/day). 4 hours is a conservative planning figure pending a real restore drill against production-scale data, not a number derived from this session's own tiny dataset. **Re-measure against a realistic data volume before treating this as a committed SLA.** |

Both RTOs are measured/estimated for a **drill restore** (into a disposable
`*_restore_drill` target, `scripts/restore.sh`'s own default) — a true emergency restore
in place additionally needs however long it takes to provision a fresh Postgres/ClickHouse
instance in the first place, which is infrastructure-dependent (see P7-06) and not counted
in either figure above.

## The real mechanism

- **Postgres**: `pg_dump -Fc` (custom format — compressed, and restorable with
  `pg_restore --data-only --disable-triggers`, never a plain-SQL dump that would need a
  slower text-based schema/data split).
- **ClickHouse**: the native `BACKUP DATABASE sentinel TO Disk('backups', '<name>.zip')` /
  `RESTORE DATABASE ... FROM Disk('backups', '<name>.zip')` SQL (confirmed present and
  stable in this stack's 24.8 image) — `infra/docker/clickhouse-backups.xml` declares the
  `backups` disk as a `local`-type disk on its own dedicated volume (`chbackups`,
  `docker-compose.dev.yml`), deliberately never the same volume (`chdata`) as the live
  data it backs up — a backup co-located with what it backs up is lost in exactly the
  failure mode (that volume destroyed) a backup exists to survive.
- **Restore rebuilds schema from migrations, not from the dump.** `scripts/restore.sh`
  creates the target database fresh, then runs the REAL Postgres migrations
  (`db/postgres/migrations/*.sql`) against it before restoring any data — ADR-0009's own
  "SQL owns the schema" applied literally: the dump is a snapshot of data, the migrations
  are the schema's actual source of truth, and a restore that silently baked a point-in-time
  schema copy into the dump instead would drift from ADR-0009 the moment a migration shipped
  after the backup was taken.
- **The audit chain verifier is NOT reimplemented for this ticket.** T3 reuses
  `packages/db/scripts/verify-audit-chain.mjs` verbatim (`pnpm --filter @sentinel/db
  verify:audit-chain`), the exact daily-scheduled verifier ADR-0007 already established —
  pointed at the restored database via `POSTGRES_URL`, not a new restore-specific chain
  checker.

This is not a design-only claim. `scripts/verify-backup-restore.sh` (`pnpm backup:verify`)
runs a REAL backup, a REAL restore, a real row-count reconciliation across both stores, and
a real audit-chain verification against the restored database — end to end, against this
session's own real dev-stack Postgres and ClickHouse. It was run fresh, not merely read,
while writing this runbook: **9 passed, 0 failed**, backup in 2s, restore in 43s.

## Procedure

1. **Take a backup**: `pnpm backup` (`scripts/backup.sh`). Writes `.backups/postgres/
   sentinel-<timestamp>.dump` (host-visible — the postgres container's own `/backups`
   mount) and `<timestamp>.zip` on the ClickHouse container's own `chbackups` volume, plus
   a `.backups/postgres/latest.json` manifest both `scripts/restore.sh` and the scheduled
   job below read to find "the latest backup" without guessing from directory mtimes.
2. **Restore it (routine drill — AC3's own "at least quarterly")**:
   `pnpm backup:restore`. Defaults to disposable `sentinel_restore_drill` targets for
   BOTH stores — never the live `sentinel`/`sentinel` database/database. Safe to run
   routinely.
3. **Restore it (true disaster recovery — the live store is actually gone)**: provision a
   fresh Postgres/ClickHouse (P7-06), then
   `RESTORE_TARGET_IS_LIVE=yes PG_TARGET_DB=sentinel CH_TARGET_DB=sentinel pnpm backup:restore`.
   The script sleeps 5 seconds after printing a loud warning before proceeding — the one
   chance to Ctrl-C before it drops and recreates a database named `sentinel` for real.
4. **Verify**, either way: `pnpm backup:verify` runs steps 1–2 AND the full
   reconciliation/audit-chain check together, in one command — this is what to actually run
   for the quarterly drill, not steps 1–2 by hand.

## Verify the restore actually worked

`pnpm backup:verify`'s own output is the authoritative check — it is not "confirm it looks
right," it is a real pass/fail per table:

```
postgres.tenants: live=49 restored=49
postgres.audit_log: live=10551 restored=10551
clickhouse.events: live=159 restored=159
ADR-0007's own hash-chain verifier passes against the restored database
```

A manual spot-check, if ever needed outside the script: connect to the restored database
directly (`psql $PG_TARGET_DB` / ClickHouse's own `${CH_TARGET_DB}.events`) and compare
`SELECT count(*)` against the live store for any table of interest.

## Monitored success (AC1)

A new scheduled job, `.github/workflows/backup.yml`, runs `pnpm backup:verify` daily (same
cadence and the same "a failed scheduled job is the alert" mechanism
`verify-audit-chain.yml` already established for the audit chain specifically) — a failed
backup, a failed restore, a row-count mismatch, OR a broken audit chain after restore all
fail this one job, surfaced via GitHub's own workflow-failure notification. **This is
disclosed as the actual, current monitoring mechanism** — not a Prometheus-paged alert (no
textfile-collector/pushgateway infrastructure exists in this stack to export a
`backup_last_success_timestamp_seconds`-style metric; building that is real, separable
follow-up work, not silently assumed already wired up).

## If something goes wrong mid-restore

- **Drill restore (`RESTORE_TARGET_IS_LIVE` unset)**: the live `sentinel`/`sentinel`
  database was never touched. Drop the half-restored `*_restore_drill` target and re-run —
  there is no rollback to perform because nothing real was ever at risk.
- **True disaster recovery (`RESTORE_TARGET_IS_LIVE=yes`)**: if `scripts/restore.sh` fails
  partway, the target database may be left with a correct SCHEMA (migrations completed) but
  incomplete DATA (the `pg_restore`/`RESTORE DATABASE` step failed or was interrupted) —
  this is a safer failure mode than a traditional single-dump restore, since the schema
  half is idempotent and re-running `scripts/restore.sh` from the top is safe (it drops and
  recreates the target database unconditionally before doing anything else). There is no
  partial-success state that silently looks complete: `pnpm backup:verify`'s own row-count
  and audit-chain checks are the thing that proves "actually finished," not the restore
  script's own exit code alone.

## Disclosed, not yet done

- **T4 ("an engineer who did not write the runbook executes the restore successfully")**
  cannot be performed by the author of this runbook — it requires an actual second person,
  which this session cannot simulate. The runbook above is written to stand on its own for
  exactly that reason (concrete commands, concrete expected output), but the AC itself is
  not yet satisfied and should not be claimed as such until a real second engineer runs it.
- **ClickHouse's `BACKUP`/`RESTORE` is issued synchronously** (`scripts/backup.sh`'s own
  `curl -sf`, which blocks until the statement completes) — fine at this session's own data
  volume (sub-second), but a production-scale backup running for minutes-to-hours would need
  the `ASYNC` keyword plus polling `system.backups`/`system.restores` instead of a single
  blocking HTTP request that could itself time out. Named here as real follow-up work for
  whoever first runs this against production-scale data, not silently assumed to already
  handle it.
