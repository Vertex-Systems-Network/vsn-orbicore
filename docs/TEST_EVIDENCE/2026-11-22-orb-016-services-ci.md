# ORB-016 — Hosted PostgreSQL/Redis service-container smoke — 2026-11-22

## CI identity and results

- Repository: `Vertex-Systems-Network/vsn-orbicore`, PR [#9](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/9).
- **Tested head SHA:** `2d46a0bac12f7631476fb72ad69529465a181e2f`.
- [Service workflow run 44996391832](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44996391832) concluded **success**. All steps passed: service initialization, checkout, Redis CLI installation, service verification, artifact upload and cleanup.
- Services: PostgreSQL image `postgres:16-alpine` (server log **16.16**), Redis `redis:7-alpine` (server log **7.4.12**). Ubuntu GitHub-hosted runner; `psql` already available; Redis CLI installed from distribution `redis-tools` during test.
- Commands via `bash scripts/verify-service-containers.sh`: apply `db/postgres-schema.sql` twice with `psql -v ON_ERROR_STOP=1`, insert synthetic organization/account/job, read job state in a separate SQL connection, assert duplicate idempotency key and invalid organization FK are rejected; `redis-cli` PING, SET, GET, TTL and DEL with a disposable key.
- [Artifact `orb-016-hosted-service-parity` (ID 14743823737)](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44996391832/artifacts/14743823737): scoped JSON listing checkout SHA, psql/redis-cli versions and boolean checks. ZIP digest `sha256:ceecc7f78009f4ac2d5f08c16e4dcfbafbdf9ba82a2107945fd73a9b2e1a472d`.
- Initial [run 44996321561](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44996321561) reached verification but failed because the runner did not have `redis-cli`; the fix explicitly installs `redis-tools`.

## What is and is not verified

**Verified:** GitHub Actions can run disposable PostgreSQL/Redis services and test the current **partial** PostgreSQL schema, synthetic database persistence across independent connections, two database constraints and Redis ephemeral round-trip. `docker-compose.yml` now declares named data volumes to avoid container-recreation data loss, but the Compose stack itself was not started or independently tested.

**Not verified:** complete schema parity with local SQLite v7, PostgreSQL-backed ORBICORE application adapter, BullMQ/Redis distributed worker integration, retry after restart, service data survival after actual container replacement, production migrations, physical infrastructure or live hosting providers. Do not mark ORB-016 complete or claim a production database/queue integration. This is `integration_tested` evidence for service-level plumbing only, with technical blockers remaining.

## Next action

Implement versioned application PostgreSQL persistence and Redis-backed durable worker contracts; write a service-backed integration test that restarts workers, resumes jobs, tests idempotency and migration rollback, and validates Compose persistence on a disposable environment. Only then revisit ORB-004/016/017 exit criteria.
