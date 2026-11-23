# ORB-004/005 — connection-local SQLite source recovery hold DML guards

**2026-11-23 UTC. Status:** Code+test feature commit created; GitHub CI and PR merge **not yet verified** at writing. CI-only synthetic data and local file-backed SQLite v7; no live provider token, remote connection, production identity, offsite key or backup/restore operation.

## Identified gap

Prior safeguards check a durable source recovery marker at startup, job-worker claim/complete, HTTP unsafe-method ingress, post-JSON awaits, bootstrap, and the shared app transaction helper. However, calls using the raw `app.db` connection could bypass these checks, including legacy direct session, user, account, audit and other SQLite writes. If a CI recovery hold were installed *after startup* from another SQLite connection, these direct row writes could advance source data outside the staged snapshot.

## Change and scope

- Install SQLite **TEMP** triggers once in each local application connection after schema setup / initial fixture seeding. For each ordinary main source table, create `BEFORE INSERT`, `BEFORE UPDATE`, and `BEFORE DELETE` denial triggers. SQL identifiers are quoted from schema metadata; SQLite internal and hold-marker tables are omitted.
- Trigger checks `main.sqlite_master` at row-write time for the known `orbicore_ci_active_recovery_hold` table or view. If found, raise `ci_sqlite_source_recovery_hold_manual_review_required`, causing SQLite statement rollback before the row changes. Without marker, existing behavior is unchanged.
- TEMP triggers do not alter the SQLite v7 schema migration manifest, and disappear when the app connection closes. Bootstrap/startup and worker/HTTP hold checks remain in place.

## Test plan

1. On a real file-backed SQLite v7 mock, enumerate all ordinary source tables; assert exactly three connection-local triggers per table and successful ordinary SQL with no marker.
2. Install marker with a *separate* SQLite connection. For each enumerated ordinary source table, attempt direct `INSERT DEFAULT VALUES` on the still-running app DB and require the hold error (not a NOT NULL error); verify jobs remain unchanged.
3. On populated accounts/schema_migrations, direct UPDATE and DELETE reject and rows remain unchanged. Intentionally write through a second, unguarded SQLite connection to document that TEMP triggers are per-connection, **not a global WORM guarantee**.
4. Invalid install inputs reject before SQL mutation.

GitHub standard Node tests, lint, supply chain, browser, PG/Redis service workflows and trusted task ledger must be checked on final PR head. At document write, their results remain pending.

## Important unresolved gates

- These ephemeral triggers do **not** fence independent SQLite connections, late-added schema tables, DDL/DROP, background PostgreSQL/Redis workers or out-of-process provider effects.
- New long-running async writes and other external runtimes still require per-connection guards / distributed leasing; no source/PG transactional commit or off-host immutable audit/key custody is proved.
- No automatic hold release is implemented or authorized. No change to ORB-004 `testing/integration_tested` or ORB-005 `in_progress/integration_tested`.

## Pre-initialization hold check and additional regression tests

Previously, startup called `createDatabase` (schema DDL, `schema_migrations` writes and fixture seeding) before the existing transactional recovery marker check. A **pre-existing hold** could therefore be ignored by initialization even though automatic running-job requeue was denied later. The database opener now checks the marker and closes/throws immediately **before** schema initialization; the existing transactional auto-requeue gate remains.

Two file-backed tests verify: (1) a marker-only partial source with an independent forensic checkpoint cannot acquire any newly seeded ORBICORE schema on denied app restart; and (2) an existing SQLite v7 source with a deliberately erased schema migration manifest cannot have that manifest silently reinserted on rejected startup. This does not establish a globally atomic fence for a hold inserted *between* opener check and later DDL, nor PostgreSQL/Redis or independent-provider isolation.
