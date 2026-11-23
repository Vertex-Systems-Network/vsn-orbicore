# ORB-004/005 — after-start source recovery hold blocks unsafe local HTTP

**Date:** 2026-11-23 UTC. **Status:** Feature branch code tests committed; hosted PR CI pending. File-backed SQLite v7 fixture only; no real provider credentials or network actions, PostgreSQL/Redis service writes or operator hold-release API.

## Finding

The previous CI-only SQLite recovery hold protected `createApp` startup and queued mock worker transitions under SQLite write transactions. A running mock HTTP process could nonetheless continue accepting new local bootstrap, session, account, queued job and other API writes after an independent SQLite connection installed that same source marker. This would advance the source snapshot after a separate staged recovery witness.

## Implementation

- On every unsafe `/api/` method, check for the marker and return HTTP **503** with the exact `ci_sqlite_source_recovery_hold_manual_review_required` error; permit only normal read methods and static GET/HEAD to proceed while held. There is intentionally no hold-release API.
- Recheck marker after each of the 30 awaited JSON-ingress sites, limiting the window for an in-flight streamed request to write after the marker was created.
- Recheck within the common SQLite `BEGIN IMMEDIATE` transaction helper (DDL cannot slip between marker check and writes while that lock is held); bootstrap has an independent transaction and its own locked check. New session issuance also checks the marker synchronously before writing.
- Retain earlier startup and local worker hold gates. No service credentials, live network or production config changed.

## Regression coverage and pending CI

1. Bootstrap owner, insert marker through separate SQLite connection, then try five unsafe HTTP paths including login/logout, sandbox account, job enqueue and demo-seed. Assert 503 and no changes to users, accounts, jobs, sessions or audit. Read-only GET health/overview still respond.
2. Install marker after startup but before first-admin HTTP bootstrap; deny even with the correct token while preserving bootstrap token and zero users/audit events.
3. Begin chunked authorized HTTP job-enqueue body, install marker from separate SQLite connection before final chunk, finish body; deny 503 and keep job ledger empty.

At document write the new tests and hosted PR checks are unverified; inspect final PR head CI (standard, PG16/Redis7 if triggered, browser and task ledger) before merge.

## Important limits

This is a **local SQLite CI-only** fail-closed mitigation, not a source/PG cross-store atomic protocol. It does not universally lock every direct mutation, fence in-flight async work after body processing, prevent a concurrent SQLite holder from racing nontransactional session writes, fence Redis or remote provider effects, or implement external witness/KMS/immutable recovery/production auth cutover. Existing status stays ORB-004 `testing/integration_tested`, ORB-005 `in_progress/integration_tested`. Never infer production recovery safety.
