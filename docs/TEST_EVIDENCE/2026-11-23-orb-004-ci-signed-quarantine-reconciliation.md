# ORB-004/005/016/017 — signed CI-only active-job quarantine reconciliation

**Date:** 2026-11-23. **State:** Initial feature branch `e245e5bf38d84ab57fa4ec553fc5179d8bab46d7` [standard CI #45161060789](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45161060789) green. **Hosted PR PostgreSQL integration passed at functional head**; final evidence-head CI and merge pending.

## Why

[PR #61](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/61) already stages non-executable active SQLite job metadata in a private, CI-only PostgreSQL table; it does not re-enqueue work. Plain SHA-256 per-row metadata checks made at staging cannot by themselves establish later integrity: an actor with PG write access could change a field and rehash it, or the source might change after staging. This checkpoint adds a separate, **ephemeral CI fixture** HMAC witness and an explicit read-only reconciliation gate, *without enabling replay*.

## Implementation

- `apps/api/ci-active-job-quarantine.mjs`: shares a single source-v7-manifest and synthetic job-row validation reader between staging, signing and recheck; source SQLite transaction is owned by the caller.
- `apps/api/ci-active-quarantine-reconcile.mjs`: exports a pure canonical per-job digest/HMAC witness signer, exact-shape witness verifier with constant-time MAC comparison, source snapshot witness signer and a **read-only** cross-store reconciler. Exact consent + GitHub Actions/CI env still required. A fresh **32-byte random HMAC key** is injected from the hosted CI script, never embedded in source, artifact or PostgreSQL, and not enabled in normal runtime.
- The witness includes only `{version,scope,nonce,count,digest,mac}` and no tenant IDs, account names, emails, job results, tokens, provider secrets, or resumable job data. Canonical digest covers sorted `[job id, strict metadata SHA-256]` pairs and is bound to the fixed scope/version, count and random 128-bit nonce by HMAC-SHA256.
- The integration script serializes the witness into a separate temporary file with owner-only file mode, then immediately reloads it. The key exists only in the same disposable CI process. A wrong/tampered/malformed witness fails **before** either DB access; changed source metadata fails before PG connection. In PG, `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` checks all allowlisted fields and source row hashes, count, and absence of any `public.organizations`, users, accounts, jobs or outbox. The verifier always rolls back PG read-only transaction and SQLite snapshot; no writes, Redis, outbox publication or worker calls.
- Existing separate private quarantine schema retains FORCE RLS / no runtime grants. This **does not** confer independent external attestation, production HMAC-key custody, cross-runner persistence or trusted deploy/rollback authority.

## Acceptance tests

1. Unit tests: valid strictly synthetic fixture, deterministic sorted witness, redacted exported shape, foreign signer, modified count/nonce/digest/MAC, invalid extra fields/key length, and denied normal-runtime signing/reconciliation.
2. PG16 hosted service negative path: verify signed checkpoint after successful two-tenant queued/running staging, wrong MAC and unrelated key fail before PG I/O, post-staging SQLite idempotency key change fails before PG access, PG account ID changed with a freshly recomputed SHA-256 still fails, unexpected quarantined row fails, and a nonempty operational public table fails.
3. Final recheck succeeds with the restored source/target, source records remain unchanged, operational `public.jobs` and `public.job_outbox` remain **empty**, and previously validated forced-mid-insert PostgreSQL rollback/tenant read-denial continue passing. No fixture actions were re-enqueued, executed, or sent to any provider.

## Honest limitations and next gates

- CI environment flags and HMAC signing key are **not** production-grade security boundaries. Anyone controlling the privileged same-runner process/key can forge a checkpoint. This is *not* an independent external witness or offsite signed audit. The test uses temporary same-runner file storage; restart durability and host compromise remain unproven.
- The source read contains only currently `queued/running` jobs; historical `completed/failed` jobs follow a different CI-only importer. This does not verify a complete real active queue, pending notifications, worker leases, cross-database crash consistency, Redis replay sequencing or external cPanel operations.
- No real login cutover, live credentials, production DB migration, worker operation, DNS or destructive actions. ORB-004/016/017 remain `testing/integration_tested`, ORB-005 remains `in_progress/integration_tested`; ORB-006/019 live checks are independently externally blocked.

## Observed GitHub proof at functional PR SHA `f69351fb6ca85258e151b71a09c60aa6996f9431`

- [Standard PR CI #45161407853](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45161407853) succeeded: **148/148 Node tests, zero failures**, including three new HMAC witness/reconciliation tests; plan, security, license and build gates passed. [Feature branch CI #45161346374](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45161346374) also succeeded.
- [Full PG16/Redis7 Service Integration #45161407766](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45161407766): **25/25 hosted jobs succeeded**, including **Disposable PG16 CI-only active job quarantine without replay** and the enhanced signed-source recheck fixture. The private PG job script ran the temporary-file HMAC witness, denied wrong signer/MAC before DB IO, denied signed SQLite drift before PG IO, rejected a PostgreSQL account mutation even when its stored SHA-256 was recomputed, rejected extra quarantine rows and public table contamination, then verified restored 2/2 synthetic rows read-only. The earlier PG trigger-fault rollback, no-grants tenant-role refusal, and empty public jobs/outbox gates continued passing. No real jobs were resumed.
- [Chromium browser/WebAuthn #45161407933](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45161407933) succeeded. [Trusted PR task ledger #45161407732](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45161407732) succeeded, preserving canonical **6 verified / 9 testing / 3 in_progress / 2 blocked** statuses.
- This is **a single disposable CI process plus an independent temporary file**, not an HSM/KMS, externally retained signature key, privileged PG adversary-proof audit, cross-machine offsite recovery, or production verification. The witnessed metadata is deliberately non-executable.
