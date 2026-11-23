# ORB-005 / ORB-017 — SQLite v7 migration-lineage preflight

**Status:** Functional PR head `c17e32e8ab571b07b401f8f0882c57cd8000d752` passed GitHub-hosted standard, browser and 24/24 PostgreSQL/Redis checks on 2026-11-23 UTC. Final documentation-only head CI/merge pending.

## Problem and scope

The CI-only SQLite→PostgreSQL importer already denies live accounts, absent explicit synthetic consent, unsupported authentication material, active queues and nonempty PostgreSQL targets. However, it did not inspect SQLite's `schema_migrations` lineage before interpreting rows. A partially upgraded, renamed, unexpected future-version or otherwise inconsistent source could be mistaken for supported v7. This checkpoint adds one **read-only** source gate, before any PostgreSQL pool connection, that recognizes precisely the seven version/name pairs actually recorded by the current local prototype's `createDatabase`. All `applied_at` timestamps must be canonical UTC ISO strings. Unknown/missing/extra versions, wrong ordering or invalid timestamps fail closed with `sqlite_v7_migration_manifest_mismatch`.

## Automated evidence contract

- `tests/sqlite-v7-manifest.test.mjs`: accept exact seven entries; reject missing/future/mismatched version/name and malformed dates. Use an in-memory SQLite `schema_migrations` table to prove the actual parameterless read gate detects tampering.
- `scripts/verify-postgres-ci-terminal-history.mjs`: before copying terminal synthetic job history, mutate source migration 7 name, then delete it; assert the importer rejects both attempts without any PostgreSQL rows, restore original records, and only then proceed with existing PG rollback/RLS/zero-outbox/real mock worker checks.
- `.github/workflows/ci-services.yml`: existing PostgreSQL16 job now carries extra negative fixture assertions; the new module/test paths trigger the service workflow. Standard CI must pass Node tests, lint/plan, security gate, offline CycloneDX schema, dependency audit, build/smoke/doctor.

**Limits:** These records are a SQLite source metadata sanity check, not a cryptographic schema/file audit, proof migrations' SQL statements actually executed, preservation of real source metadata in PostgreSQL, active job migration, production/HTTP authority cutover, off-host backup or live provider validation. The original source `schema_migrations` table remains untouched by a successful preflight. ORB-005 remains `in_progress/integration_tested` and ORB-017 remains `testing/integration_tested`.

## Observed GitHub Actions validation

- [Standard PR CI #45155046168](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45155046168) and [feature CI #45154996672](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45154996672): **success** at functional SHA `c17e32e8ab571b07b401f8f0882c57cd8000d752`. **142 passing Node tests, 0 failed**, including two new v7 manifest tests. Lint/plan, tracked-secret/license check, official offline CycloneDX 1.5, npm audit, build, smoke and doctor passed.
- [PostgreSQL16/Redis7 integration #45155046035](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45155046035): **24 of 24 jobs successful**. The dedicated terminal synthetic history job now intentionally changes and removes the SQLite version-7 record, expects `sqlite_v7_migration_manifest_mismatch` before PostgreSQL data mutation, restores the record and then completes its real-local-worker, source-immutable, tenant-RLS, injected rollback and zero-outbox integration.
- [Chromium/WebAuthn/accessibility #45155045921](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45155045921) and [trusted PR task-ledger #45155045968](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45155045968): both **success**.
- This is synthetic CI proof of a metadata preflight, **not** a production migration, cryptographic proof of historical migration execution, or live provider/credential authority. Canonical task statuses remain unchanged.
