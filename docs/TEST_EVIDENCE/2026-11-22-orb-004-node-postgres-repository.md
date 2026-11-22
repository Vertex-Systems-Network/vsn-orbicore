# ORB-004 — Node.js PostgreSQL job repository integration — 2026-11-22

## Hosted evidence

- Repository: `Vertex-Systems-Network/vsn-orbicore`; PR [#11](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/11).
- **Exact tested feature SHA:** `57dec33e52c64e9c4bf5ea00a6382eb725512983`.
- [GitHub Actions service run 44997469316](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44997469316): **success**, including previous PostgreSQL schema/lease/Redis Stream checks, a pinned test-only Node PostgreSQL client install, real repository operations and JSON evidence upload.
- [Standard CI run 44997469273](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44997469273): **success** — **47 tests passed, 0 failed**, lint, scoped security/license scan, reproducible SBOM upload, `npm audit --audit-level=high` (0 reported vulnerabilities in the checked set), build, smoke and doctor. [Chromium browser run 44997469354](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44997469354): **success**.
- GitHub Ubuntu runner, PostgreSQL 16 service, Redis 7 service, Node 24, test-only `pg@8.16.3` via `npm install --no-save --package-lock=false --ignore-scripts --no-audit` after `npm ci`. Driver is not yet a declared production runtime dependency.
- [Repository JSON artifact (ID 14743899380)](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44997469316/artifacts/14743899380), ZIP SHA-256 `aca8070c7214a8b14a534d5833cebd5c6cb7a87217cc556d56c24863090a329e`. Also [lease/stream evidence (ID 14744512065)](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44997469316/artifacts/14744512065).
- Verified code: `apps/api/postgres-jobs.mjs`, `tests/postgres-jobs.test.mjs`, `scripts/verify-postgres-job-repository.mjs`.

## Covered behaviors

- A real injected `pg.Pool` executes parameterized SQL for synthetic tenant-scoped `inventory_refresh` job insertion, scoped retrieval, claims, lease-token completion and expired-attempt failure.
- Same-tenant duplicate idempotency key returns the existing job without enqueueing another. The repository hashes tenant ID and caller key before using the schema's global unique index; identical caller keys in two separate tenants therefore do not collide.
- A reused idempotency key for another account is rejected; tenant-scoped getters do not leak another tenant's job; a cross-tenant account insertion is rejected by the composite FK. Identifier validation prevents malicious/invalid identifiers from reaching SQL.
- The first `pg.Pool` is closed, another pool reconnects and reclaims a synthetically expired lease. Old owner completion is rejected; the new token succeeds and returns persisted JSONB results. Exhausted attempts move a job to `failed`.
- Unit tests confirm SQL values are bound as parameters, not interpolated, and invalid fields/lease inputs are refused.

## Incomplete gates

- **The API and its background worker still use SQLite.** This module is injectable and tested directly, but is **not instantiated by `createApp`**, has no production `pg` dependency in the checked-in lockfile, and does not yet integrate with Redis event consumers.
- Node client pool closure/reconnection was tested; **not** actual OS process kill/restart, server/container replacement, or multi-instance deployment.
- The Redis Streams contract is separately tested by `scripts/verify-leased-jobs.sh`; there is no transactionally safe PostgreSQL outbox-to-Redis publisher, application worker, ACK/retry handling, authorization/RLS or provider policy recheck.
- Do not upgrade ORB-004 or ORB-016 lifecycle to `verified`; full schema/migrations, real app integration, production credentials and deployment recovery remain unverified.
- This evidence file was added **after** the tested feature SHA. The final PR head requires independent standard CI and service checks.

## Next

Declare/pin production PostgreSQL and Redis driver dependencies, integrate a single authenticated job API vertical slice behind a swappable DB/queue port, implement a persistent transactional outbox and Redis consumer, and verify cross-process crash/lease recovery and service/container volume persistence in a disposable GitHub-hosted environment. Preserve SQLite fixture mode and its 47 tests.
