# ORB-004 / ORB-005 / ORB-016 / ORB-017 — terminal synthetic job ledger import

**Status:** PR GitHub-hosted service verification pending. **Date:** 2026-11-23.

## Scope
The existing CI-only SQLite→PostgreSQL source importer had explicit refusal of any existing SQLite `jobs` rows. This checkpoint introduces a separate, stricter consent path, `fixture_only_terminal_jobs_offline_copy`, which copies core identity, authentication fixture state, seven operational feature tables, **and solely completed/failed synthetic inventory-refresh job history** in one PostgreSQL serializable transaction. The standard core/auth/feature import paths retain their refusal of nonempty `jobs`.

The extension still refuses active `queued`/`running` jobs, all non-fixture job types, missing or cross-tenant `requested_by`, non-fixture idempotency keys, unsafe/malformed results, provider-live payloads, source secrets, live account sources, and copying into any nonempty target (including `job_outbox`). Terminal job results are synthetically tagged (`ciFixture:true`, `source:mock_fixture`, `live:false`) with a small allowed-field set. Failed jobs require the explicit fixture-only failure code, no arbitrary provider errors. No jobs are enqueued and no Redis events are produced.

## Verification plan
New `tests/postgres-terminal-job-history.test.mjs` asserts status, account/user tenant, timestamp, synthetic metadata/payload denial, SQL parameters and consent-before-I/O. A dedicated job in `.github/workflows/ci-services.yml` provisions fresh PostgreSQL 16, applies migrations 001–005, and runs `scripts/verify-postgres-ci-terminal-history.mjs` with explicit CI and feature gates. The script seeds two synthetic tenants, tests rejection of active jobs, malicious payloads and cross-tenant requester, injects a PostgreSQL trigger error during an otherwise valid transfer and proves every identity/audit/job insert rolled back, then successfully copies two terminal jobs preserving timestamps, status, result and tenant RLS. It checks no `job_outbox` rows, unmodified source and nonempty destination replay denial.

## Acceptance / limitations
Only after workflow completion may counts and a run URL be reported as verified. The job history transfer is **not a resumable active job queue migration**; source SQLite is still authoritative for the default HTTP app, and PostgreSQL does not become production authentication or worker authority. No off-host encrypted backup, production secrets/MFA material, real KMS, SSO, host failure, live cPanel, Redis replay, independent key custody, or actual production cutover is demonstrated. ORB-004/016/017 remain `testing/integration_tested`, ORB-005 stays `in_progress/integration_tested`, and ORB-006/019 remain externally blocked.
