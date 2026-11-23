# ORB-004/016/017 — actual PG16 backend termination and transactional lease fencing

**Date:** 2026-11-23. **State:** PR CI pending; no production recovery claims.

## Gap targeted

The existing hosted PostgreSQL/Redis service suite proves tenant-scoped lease claims, stale-token denial after expiry, and reconnect behavior with manually advanced lease timers; it also tests worker process termination after a claim. These checks do **not** explicitly force-terminate a *PostgreSQL backend mid-uncommitted claim transaction* and compare persisted state to the committed-claim crash case. A wrongly claimed durable attempt may cause double work or prematurely exhausted retries. This bounded fixture adds that missing database transaction boundary proof.

## New hosted scenario

- `scripts/verify-postgres-ci-backend-crash-fencing.mjs` is not callable outside GitHub Actions with both `ORBICORE_CI_PG_BACKEND_CRASH_FENCE=1` and `ORBICORE_CI_NO_PROVIDER_CALLS=1`. The destructive `pg_terminate_backend(...,5000)` operation targets **only the fresh isolated PostgreSQL16 CI container**, never an external host. It does not contact Redis or any provider.
- Use randomly named disposable two-tenant organizations/accounts and mocked `inventory_refresh` jobs, migration `db/migrations/001_postgres_job_leases.sql` and existing `002_postgres_job_outbox.sql`. Source PostgreSQL is the sole DB under test; **no** SQLite queue, identity, encrypted token or production data is present.
- **Before commit:** Claim within an explicit PostgreSQL transaction, terminate that backend, require its COMMIT to fail, verify status remains `queued`, attempts=0, NULL ownership/token/expiry/completion. New connection must claim at attempt 1 with distinct token from aborted claim.
- **After commit:** Claim using a new session, terminate a separate backend to simulate loss of worker DB connectivity *after* claim commit, observe running status/attempt/token persist. Existing unexpired claim rejects other workers.
- **After fixture expiry:** Advance expiry by a controlled SQL UPDATE only in disposable CI DB; replacement claim must get a different lease UUID and attempt 2. Pre-commit and post-commit stale tokens cannot complete, wrong-tenant token cannot complete, current token completes exactly once. A different tenant with one allowed attempt is terminally failed after expiry and cannot be reclaimed.
- Assert zero PostgreSQL job outbox rows, zero Redis signals and zero live provider calls. New `tests/ci-backend-crash-fencing.test.mjs` subprocess tests ensure omitted CI or either opt-in is denied **before PostgreSQL connectivity**.
- CI workflow adds an isolated service job `postgres-ci-backend-crash-fencing`. Standard Node, security, build, browser and trusted task ledger remain required. Record full tested head SHA, action links, any failures/fixes and postmerge status once observed.

## Limitations

The second termination occurs on a client connected *after* the durable claim, rather than the claiming client; this still tests persistence across backend loss, not process-level worker shutdown and all in-flight provider effects. The first case does terminate the actual claiming backend mid-transaction. Forced expiry by privileged CI SQL does not prove real wall-clock scheduling or distributed fencing, and stale token invalidation is only guaranteed **after the newer claim**. Existing `orbicore_claim_job` SQL still permits automatic retries for synthetic jobs; real provider effects might be non-idempotent. **No SQLite-to-PG transaction atomicity, no Redis replay/drain gate, no cPanel calls, no operator-approved actual replay, no production key custody and no real host crash recovery** are demonstrated. ORB-004/016/017 lifecycle remains `testing/integration_tested`; ORB-005 remains `in_progress/integration_tested`.
