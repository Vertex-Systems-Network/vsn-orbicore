# ORB-004 — Hosted PostgreSQL leases and Redis Streams redelivery — 2026-11-22

## Verified identity

- Repository: `Vertex-Systems-Network/vsn-orbicore`, PR [#10](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/10).
- **Tested exact source SHA:** `33eaebafb6aee7eac133700f75e764a771089c18`.
- [Service Actions run #44997036564](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44997036564): **success**. [Standard CI #44997036640](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44997036640): **success**. All tests, lint, security audit, SBOM, build, smoke and doctor steps passed.
- GitHub Ubuntu runner, PostgreSQL `postgres:16-alpine`, Redis `redis:7-alpine`; `psql` + installed `redis-tools`. The exact service patch versions and client versions can be checked in the job logs and associated JSON artifacts.
- `bash scripts/verify-service-containers.sh`, `bash scripts/verify-leased-jobs.sh`. Additive schema migration `db/migrations/001_postgres_job_leases.sql` applied twice under `ON_ERROR_STOP=1`.
- [Job-lease evidence artifact (ID 14744076348)](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44997036564/artifacts/14744076348), ZIP SHA-256 `3f2260c21b633157f4e4df204eb9f5a4c322d4105d92eed8f1f012e30e1bef71`; [service-parity artifact (ID 14744276043)](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44997036564/artifacts/14744276043).

## Checks observed in passing hosted run

- Tenant/account composite foreign key rejected cross-tenant job insertion.
- `orbicore_claim_job` atomically selects one eligible tenant job using `FOR UPDATE SKIP LOCKED`, increments attempt count, assigns a unique lease token and expiration.
- Separate PostgreSQL client sessions exercised first claim, lease expiry (manually moved into the past), reclaim on another worker ID, stale-token completion refusal and active-token completion.
- A max-attempts=1 job expired and `orbicore_fail_exhausted_jobs` marked terminal failure; no further claim succeeded.
- Two concurrent PostgreSQL clients contended for one job; exactly one returned its ID and the job's attempt count stayed 1.
- Redis Streams worker A read an event without ACK and terminated its command; worker B used `XAUTOCLAIM` and ACKed the same event. Pending entries count went 1 → 0.
- SQL migration reapplication was idempotent on the tested disposable DB.

## Strict boundaries / gaps

- **This is an isolated PostgreSQL/Redis worker *contract* and test harness; the ORBICORE web/API and current worker remain on local SQLite.** The production PostgreSQL adapter, real Redis-backed application worker, and transactionally reliable DB-to-stream outbox are **not yet implemented**. A Redis signal without an outbox could be dropped, and delivery is at-least-once rather than exactly-once.
- Lease expiry was forced by a synthetic SQL update; no real worker process was killed/restarted, and no Postgres/Redis container was stopped/recreated with persistent volumes.
- PostgreSQL functions receive an organization ID but do not themselves implement database role authorization or row-level security. The application must authenticate the caller/worker and enforce tenant policy independently. Use a scoped DB role and consider RLS in the production adapter.
- External destructive/provider-side operations require fresh policy and fencing immediately before execution; a lease token alone cannot undo an already executed external side effect.
- PostgreSQL schema is partial relative to SQLite v7. Migration rollback/backfill, production recovery, queue durability on disk and complete install/upgrade remain future tests. Do not close ORB-004/016/017 based solely on this run.

## Next engineering step

Add a tested PostgreSQL adapter for a single job API vertical slice, durable Redis worker and transactional outbox with idempotent enqueue and restart/failover testing; keep the existing SQLite fixture path unchanged. Record separately the run that proves the real API and worker use the new services.
