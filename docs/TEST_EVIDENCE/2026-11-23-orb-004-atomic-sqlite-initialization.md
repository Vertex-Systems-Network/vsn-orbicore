# ORB-004/005 — SQLite startup initialization and recovery hold share one writer boundary

**Date:** 2026-11-23 UTC. **State:** Feature code/tests committed; hosted branch and final PR-head checks pending when this record was drafted. Only synthetic local SQLite fixture, no live credentials, provider calls, production PostgreSQL/Redis or offsite recovery.

## Finding

A pre-existing CI source recovery-hold marker was rejected at database open, but a hold installed *during* initialization could race between several autocommit schema/migration statements and the later fixture-only `BEGIN IMMEDIATE`. A separate connection could therefore observe incomplete initialization or insert the recovery marker before the initializer finished. An exception in the second synthetic account seeding transaction could also leave schema and migration-manifest writes already committed even though account seeding rolled back. This is inconsistent with treating the local mock source as a single recovery-boundary snapshot.

## Implementation

- Open source; fail closed on an already present recovery marker. Set connection PRAGMAs `foreign_keys=ON` and `journal_mode=WAL` **before** the writer transaction (SQLite does not permit changing them inside a transaction).
- Acquire `BEGIN IMMEDIATE` and **recheck** the marker while holding the SQLite writer lock, before any `CREATE TABLE`, additive `ALTER TABLE`, schema-migration INSERT, organization or fixture data write.
- Keep all remaining schema/manifest/fixture updates in that *same* transaction; remove the old nested seed transaction, which could not nest within the new outer one.
- Install the connection-local temporary recovery-hold DML triggers in that same initialization lifetime; commit only after all checks succeed. On any thrown error, attempt rollback (also handles early pretransaction errors), close the opened SQLite connection and rethrow. Existing `createApp` separate locked crashed-job requeue policy is unchanged.

## Regression cases

1. Clone checked-in fixture; make the second account violate `used_bytes >= 0`. App creation must throw a CHECK error and leave **no application tables** or migration rows in a fresh source (all schema DDL rolled back). A subsequent valid startup on the same file must create exactly the expected seed accounts and seven schema migration versions.
2. Create a deliberately malformed legacy `accounts(id)` table, then run initialization. Legacy-column `ALTER TABLE` statements and other DDL run but fixture insertion fails due to missing `label`; the complete transaction rolls back, restoring the original one-column table and creating no other schema.
3. Clean file-backed init and idempotent restart still have exactly the expected accounts, migration sequence 1–7, no queued jobs.

## Limits

`BEGIN IMMEDIATE` serializes **SQLite writer transactions on the same file**, including a competing writer attempting to establish the marker. This does not protect independent foreign databases/PG, Redis, providers or host failures. PRAGMA journal-mode selection precedes the writer lock but is guarded by an initial marker check; a hypothetical concurrent marker in that narrow PRAGMA window is detected at the inside-transaction recheck before schema/DML. No distributed hold lease, DDL authorizer, immutable source record, off-host admin custody, production identity cutover or owner-authorized cPanel proof is added. ORB-004 remains `testing/integration_tested`; ORB-005 remains `in_progress/integration_tested`.

**Hosted evidence:** pending; inspect final PR SHA, standard Node counts, scoped PostgreSQL16/Redis7 jobs, Chromium/Firefox/WebKit, trusted task ledger and post-merge main before claiming success.

## Hosted PR #80 functional-head results

At code+docs PR SHA `030f421b3b4ac5c3314493459bb03d276524e8c6`, GitHub Actions reported:

- [Standard CI #45208581989](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45208581989) **success: 194/194 Node tests** (three new atomic-initialization cases), lint/plan/security, SBOM/schema validation, npm audit, build/smoke/doctor.
- [PostgreSQL16 / Redis7 service integration #45208581964](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45208581964) **success: 28/28 disposable jobs**. These are CI service/synthetic parity tests, not production distributed recovery.
- [Browser E2E/accessibility #45208582220](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45208582220) **success: 3/3 Chromium, Firefox, WebKit jobs**.
- [Trusted task ledger #45208583344](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45208583344) **success**, canonical 20-row status table unchanged.

Documentation-only evidence commit/final-head recheck and merge remain separate pending gates at this entry's creation. This work leaves ORB-004 `testing/integration_tested` and ORB-005 `in_progress/integration_tested`; PostgreSQL identity cutover, off-host key custody and live cPanel remain unsupported.
