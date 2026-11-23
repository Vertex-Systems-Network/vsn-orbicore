# ORB-004/005/016/017 — private PG16 quarantine of active synthetic jobs

**Date:** 2026-11-23 UTC. **Status:** Functional PR head `d4e0e130236b78653484379c5d7d6c09a811342f` passed hosted CI, PG16/Redis7, Chromium and ledger. Final evidence-head CI/merge pending.

## Purpose and safety boundary

The existing offline SQLite v7→PostgreSQL importer correctly refuses queued/running jobs. They cannot safely be re-enqueued because source SQLite worker claims have no cross-store lease fencing, deployment authorization or Redis replay policy. This checkpoint deliberately does **not** make them runnable. A separate **GitHub-Actions-only** operator-explicit fixture function `stageSyntheticActiveJobQuarantine` collects safe **metadata only** in a fresh PostgreSQL private `orbicore_ci_quarantine.active_jobs` table, not in `public.jobs`. The separate SQL is under `db/ci-fixtures/` (not production migrations), no RLS policy or runtime grants, and no real provider credentials, job results, application secrets, notification payloads, queue signals, Redis streams, runtime sessions or provider actions are copied.

## Implemented acceptance gates

- Requires all three: GitHub Actions runner, `ORBICORE_CI_ACTIVE_QUARANTINE=1`, exact consent `ci_fixture_active_jobs_quarantine_no_replay`.
- Source `schema_migrations` must match exact SQLite v7, accounts must all be `mock_fixture`, users must have `.test/.invalid` addresses, no secret references may exist; 1–20 active synthetic `inventory_refresh` jobs only.
- Each queued/running row must have a valid source tenant/account/requester, requester role owner/admin/operator and not disabled, tenant-prefix-consistent `ci-queue-*` idempotency key, UTC ISO timestamps and no terminal payload/error/completion timestamp. Queued rows cannot have started timestamps; running rows require them.
- Metadata only includes fixed allowlist of job ID, tenant/account/requester, queued/running status, fixture key, creation/start times and SHA-256 digest over its canonical fixed record.
- A serializable PG transaction with advisory lock refuses nonempty public identity/accounts/job/outbox or prior quarantine target; a mid-insert failure rolls back all quarantined metadata. After inserts, every stored row is compared to the source allowlist/digest before commit, and operational public `jobs` and `job_outbox` must remain empty.
- Private schema revokes PUBLIC usage, has forced default-deny RLS with **no runtime policy**. Non-owner tenant read role cannot access staged metadata.
- Source SQLite is held in a snapshot transaction and always rolled back without mutation. Reimport into occupied target fails closed.

## GitHub validation plan

`tests/ci-active-job-quarantine.test.mjs` covers valid fixture queued/running inputs, malicious/live/malformed shapes, tenant/actor/key tampering, duplicate/oversized metadata, and consent gates. `.github/workflows/ci-services.yml` adds a separate PostgreSQL16 service job running `scripts/verify-postgres-ci-active-quarantine.mjs`: repeatable private DDL; synthetic two-tenant source; malformed data and migration manifest denial; dirty target denial; injected failure after first insert and transactional cleanup; successful two-job quarantine; owner-only private relation; zero public jobs/outbox; unchanged SQLite source; and replay refusal.

## Limitations

This is disposable synthetic metadata, **not recovery of live active jobs**. Running work is never resumed; queued work is not enqueued, automatically accepted or processed. No authenticated production HTTP route imports or reads the private schema; no off-host recovery, encrypted keys, live cPanel provider, full SQLite→PG auth cutover, complete source job history/queue migration or production trust boundary is proven. Canonical lifecycle remains ORB-004/016/017 `testing/integration_tested`, ORB-005 `in_progress/integration_tested`.

## Observed hosted results

- [Standard PR CI #45156764209](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45156764209) passed **145/145 Node tests, zero failures**, including three new quarantine tests. Plan validation, lint, security/license scan, vendored official CycloneDX validation, dependency audit, build, smoke and doctor passed.
- [Service Integration #45156764198](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45156764198) passed **25/25 PostgreSQL16/Redis7 jobs**. The new [active job quarantine job #137631578505](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45156764198/job/137631578505) passed private schema idempotence, two-tenant queued/running source fixture, strict consent/payload/tenant denial, occupied-target refusal, injected late PostgreSQL failure rollback, per-row digest parity, forced/default-deny RLS read denial, unchanged SQLite source, replay refusal, and **zero public jobs and zero job-outbox rows**. CI artifact upload also succeeded.
- [Browser E2E/Chromium #45156764172](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45156764172) and [trusted PR task ledger #45156764453](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45156764453) passed on the same functional SHA. [Feature-branch CI #45156708024](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45156708024) passed.
- Earlier [branch test run #45156309025](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45156309025) exposed a **test fixture assertion order** problem: the wrong-tenant prefix was rejected before the intended tenant-actor guard. That fixture was changed to use its own consistent prefix, then [CI #45156573765](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45156573765) and the later PR CI were green.
- **Not production verified:** live active jobs remain unrecovered; no worker replay, active Redis signal, real provider, production identity, off-host backup or key management was enabled or tested. Canonical task statuses remain unchanged.
