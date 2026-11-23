# ORB-004/005 — persistent SQLite recovery-hold DML guards across file connections

**Date:** 2026-11-23 UTC. **Stage:** Feature code and tests are on a dedicated GitHub branch. Hosted CI/PR checks pending at evidence-plan creation; synthetic local file-backed SQLite only, no live provider or external service operation.

## Previously demonstrated gap

PR #78 installed SQLite `TEMP` BEFORE INSERT/UPDATE/DELETE triggers on each local application's `DatabaseSync` connection. Those triggers are omitted from the main SQLite schema and disappear after connection close, so an independent connection—even one opened while the application is running—could modify source tables *after* an independent recovery-witness writer installed the durable hold marker. Existing HTTP and worker path checks do not bind arbitrary direct SQLite connections.

## Change

- For each non-internal source table other than the hold marker, create **main-schema** `BEFORE INSERT`, `BEFORE UPDATE` and `BEFORE DELETE` triggers; each queries `main.sqlite_master` for the committed CI-only marker and issues `RAISE(ABORT, 'ci_sqlite_source_recovery_hold_manual_review_required')` before row mutation. They remain active after app shutdown and apply to subsequent SQLite connections.
- Trigger names derive from hex encoding of each original UTF-8 table name and the operation. This avoids index-based renaming/collisions if another source table is inserted alphabetically earlier on a subsequent upgrade. SQL source-table identifiers are quoted.
- Detect pre-existing same-named trigger bound to another table or lacking the required marker/abort contract and **fail closed** with `ci_sqlite_source_guard_conflict` rather than assuming a valid guard. Install is idempotent.
- PR #80 already placed initialization and guard installation inside a single `BEGIN IMMEDIATE` transaction; DDL succeeds atomically with migration/fixture seed or rolls back on failure. The existing HTTP and mock-worker checks remain independent defense layers.

## Regression plan

1. Enumerate ordinary SQLite tables and assert three **persisted main-schema** trigger guards per table and no hold-denial when marker absent. After creating marker on another connection, attempts to `INSERT DEFAULT VALUES` on every table fail with the existing hold error.
2. Update/delete on populated accounts/schema rows are blocked after marker establishment; explicitly verify the separate connection can **no longer** bypass with ordinary UPDATE.
3. Stop the app; reopen source using two independent SQLite connections, install hold, then attempt independent INSERT/UPDATE/DELETE and ensure unchanged organization/account/migration counts. A held restart still refuses schema initialization.
4. Add a new source table alphabetically earlier than all originals between two clean app startups; the old trigger list must remain unchanged and exactly three stable new guards must appear.
5. Invalid inputs rejected and repeated installation must not duplicate triggers.
6. Deliberately replace an existing persisted INSERT trigger with a harmless, same-name but **non-denying** trigger; clean source restart must fail with `ci_sqlite_source_guard_conflict` rather than silently trust a malformed definition, without changing existing account/migration rows.

GitHub Node CI, browser jobs, path-scoped PG16/Redis7 service jobs, and trusted PR ledger are verification gates. Until the measured results are recorded no pass claim is made.

## Limits and scope

The triggers modify the **main SQLite schema** and persist in the local mock database; this does not change the SQLite `schema_migrations` version because it is a source recovery guard, not a production data-model migration. A privileged SQLite client with DDL privileges can `DROP TRIGGER` or modify schema/files; new source tables created after the guard install remain unprotected until the next controlled initialization, which is refused if a marker already exists. This is **not** WORM, tamper-proof or adversarial file custody. It also does not fence unrelated PostgreSQL or Redis stores, provider effects, backup/restore, distributed identity, or external key/witness services. ORB-004 stays `testing/integration_tested`, ORB-005 `in_progress/integration_tested`.
