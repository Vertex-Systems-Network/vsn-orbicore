# ORB-004 — PostgreSQL transactional outbox + Redis synthetic job worker — 2026-11-22

## GitHub-hosted verified checkpoint

- Repository: `Vertex-Systems-Network/vsn-orbicore`, [PR #14](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/14).
- **Tested functional head:** `037e7bd9e00067db6a3f5474099e9598f2472102`. [PostgreSQL/Redis service run #45002004269](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45002004269) **success** on this exact head, including opt-in separate executable verification. Earlier functional [#45001980352](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45001980352) **success** on `5ea7d17c09c9130984aa27b50e2eeca3b4b59a8d`.
- [Standard CI #45002004261](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45002004261) **success**: **52 tests passed, 0 failed**, lint, build, smoke/doctor and security checks including npm high/critical audit **0 reports at test time**. [Hosted Chromium #45002004230](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45002004230) **success** on same head. Lockfile-only CycloneDX 1.5 SBOM 189 components/0 unresolved dependencies; not a complete deployed-service inventory.
- Disposable GitHub Ubuntu host, Node.js 24, PostgreSQL `postgres:16-alpine` and Redis `redis:7-alpine`, checked-in `pg@8.23.1` and `redis@6.3.1`. Migration `db/migrations/002_postgres_job_outbox.sql` applied twice using `psql -X -v ON_ERROR_STOP=1`; prior migration 001 and partial target schema also tested.
- `npm ci`, `node scripts/verify-pg-redis-outbox.mjs`, `node --test tests/*.test.mjs` and earlier service, browser and gate workflows, not local-only evidence.
- [Outbox and worker evidence JSON artifact #14746690226](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45001980352/artifacts/14746690226) (SHA-256 of ZIP: `442bc85d854730fed77651eb2712a0dd44de6a525a31287236c145d8891141c5`). Functional run #45002004269 also uploaded matching scoped evidence.

## Behavior actually tested

- **Atomic PostgreSQL transaction:** an authenticated HTTP job insertion using `createTransactionalOutboxJobRepository` commits a matching tenant-scoped `job_outbox` intent or rolls back the job if outbox insert fails. Duplicate idempotency key does not create another job or outbox row. The PostgreSQL migration is idempotent in hosted DB.
- **Publication failure:** a synthetic Redis failure during `XADD` rolls back the publisher transaction; the outbox row remains unpublished and a later attempt delivers the event. A successful Redis publication is marked in PostgreSQL after writing to the stream.
- **At-least-once delivery:** duplicate stream events are acknowledged without processing terminal jobs a second time; the job lease is fenced with a fresh token on each claim. Redis has no credential, provider command or complete job payload, only synthetic tenant and job IDs.
- **Real worker OS-process death:** a separate Node process in `scripts/fixtures/hold-synthetic-worker.mjs` read the Redis event, claimed its PostgreSQL job and remained suspended. The parent sent `SIGKILL`, observed the `running` job and one pending Redis message, then forced a test lease expiration and reclaimed that pending entry via `XAUTOCLAIM`. A second worker completed the job with attempt count 2.
- **Fresh policy:** changing the test user's PostgreSQL record to disabled caused the worker to reject the synthetic job and mark it failed with `synthetic_policy_denied`; no live provider call was made.
- **Signal loss reconciliation:** deleting a stream entry, aging its outbox publication timestamp and invoking `reconcileUnfinished` caused the unfinished PostgreSQL job to be republished and completed.
- **Standalone process:** an explicit `ORBICORE_ENABLE_SYNTHETIC_REDIS_WORKER=1` one-shot Node worker process, separate from the HTTP app, published and consumed a synthetic PostgreSQL job; it does **not** start by default. The legacy SQLite worker remains the default with no injected PostgreSQL repository.

## Precise incomplete gates

- **NOT production PostgreSQL migration:** the proof uses SQLite-authenticated HTTP endpoints, with synthetic identity and account rows manually mirrored into PostgreSQL for the worker's PG-side authorization checks. No robust synchronization, PostgreSQL identity/session schema parity, role-specific DB accounts/RLS, or atomic cross-store audit.
- **NOT exactly-once external actions:** Redis publishes at least once; a crash after `XADD` but before PostgreSQL publication marker can cause duplicates. Lease fencing ensures one PG completion but cannot undo non-idempotent remote effects. **No live cPanel, WHM, migration, DNS, external service mutation or production workflow was authorized or executed.**
- **NOT full disaster recovery:** the test sends a genuine `SIGKILL` to a worker process; lease expiration was then **manually accelerated** in PostgreSQL. It does not kill/restart PostgreSQL/Redis containers or verify Docker Compose named-volume persistence and actual cloud failover, Redis AOF, backup/restore or multi-node race at scale.
- **Synthetic worker is explicitly opt-in**, not automatically deployed with `npm start`; production credentials, full complete schema, process supervision and tenant/policy hardening remain open. `ORB-004` and `ORB-016` must remain `testing` / `integration_tested`, not `verified`.
- The evidence file was authored after the tested functional head. Final PR head/checks/merge must be verified independently.

## Next exit

Migrate identity, accounts, audit and policy authority coherently into PostgreSQL; add service-scoped DB roles and RLS, migration/rollback/backup tests, Redis AOF and Compose named-volume recreation tests; test worker restarts without manually advancing the lease clock. Keep provider calls disabled until scoped disposable credentials and controls are verified.
