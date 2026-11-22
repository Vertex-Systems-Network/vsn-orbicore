# ORB-004 — Authenticated PostgreSQL-backed HTTP job slice — 2026-11-22

## Verified identity and runtime

- Repository: `Vertex-Systems-Network/vsn-orbicore`; [PR #12](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/12).
- **Feature/tested SHA:** `04b396f05611594012a84998581e91172a5fcd6e`.
- [GitHub Actions PostgreSQL/Redis run 44998235408](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44998235408): **success** including previous service, lease, Redis Streams and PostgreSQL Node repository tests, plus **real authenticated HTTP application test** `node scripts/verify-postgres-job-http.mjs`.
- [Standard CI run 44998235385](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44998235385): **success**, **49 tests passed, 0 failed**, lint, scoped secret/license gate, npm high/critical audit (0 findings at test time), deterministic npm lockfile CycloneDX artifact, build, smoke, doctor.
- [Chromium virtual-authenticator run 44998235393](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44998235393): **success**, protecting existing default SQLite authentication UI.
- Hosted `postgres:16-alpine`, `redis:7-alpine`, Node 24, test-only `pg@8.16.3` installed after `npm ci`; fixture-only SQLite identity and accounts with explicit synthetic account inserts in PostgreSQL (not production synchronization).
- [HTTP integration JSON artifact ID 14745205043](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44998235408/artifacts/14745205043); other service/repository/stream artifacts published by the same run.

## Verified behavior

- `createApp({ jobRepository: createPostgresJobRepository(pool), startWorker: false })` activates an **explicit test-only hybrid job mode**. The default SQLite bootstrap, authentication, inventory and local worker path remain unchanged.
- Authenticated owner can enqueue `inventory_refresh` via `POST /api/jobs/refresh`. Job persists in real PostgreSQL `jobs` table (not SQLite). `GET /api/jobs`, `GET /api/jobs/:id` and `GET /api/overview` read it with tenant filtering and label sourced from the caller's SQLite tenant.
- Repeated idempotency key returns existing job (200), and different account with same key returns 409 without a duplicate job.
- Unauthenticated requests are rejected; a same-tenant viewer may read jobs but cannot enqueue (403); another tenant cannot list or read the job.
- An injected test harness uses the previously verified PostgreSQL lease/claim/complete methods to complete the synthetic job, and HTTP retrieval reflects its final persisted state. Audit-chain verification passes for the local enqueue event.
- A deliberately failing injected repository returns sanitized HTTP 503 without exposing driver errors. Adapter validation rejects `startWorker:true` and missing methods.
- The standard test count rises from 47 to **49**. No production provider credentials or live hosting actions.

## Boundaries requiring new engineering and tests

- The identity/session, account inventory, audit trail and rest of the application **still use SQLite**. The test fixture explicitly seeds corresponding PostgreSQL organization/account references. Cross-store referential integrity, synchronization and audit atomicity are **not** guaranteed.
- PostgreSQL job mode is **not a production runtime switch**; it is activated only by explicit programmatic injection and requires `startWorker:false`. No job executor was wired; the synthetic completion occurred directly through the test harness.
- The PostgreSQL client is still only installed during service CI; `pg` is not a production dependency in the npm lockfile. Redis Streams signal redelivery is tested separately but not connected to HTTP job creation. No transactionally safe outbox, dedicated consumer, full production worker, actual process kill/restore or Compose volume reboot was tested.
- An enqueue in PostgreSQL and audit event in SQLite are separate transactions; in the event of a crash between commits an unlogged queued job can remain. **Do not enable this hybrid job mode for production accounts.**
- This document is committed after the functional feature SHA; verify final PR head and merged SHA independently.

## Next gate

Introduce pinned production PostgreSQL and Redis driver dependencies, a single durable authenticated job worker with transactional outbox and policy rechecks, a migration from SQLite identity/accounts to complete PostgreSQL schema, and process/Compose crash-recovery tests. Keep the existing SQLite development mode working.
