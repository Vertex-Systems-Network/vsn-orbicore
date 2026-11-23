# ORB-004/005/016/017 — CI-only Ed25519 active-job quarantine evidence across runners

**Date:** 2026-11-23 UTC. **State:** PR and service checks pending; no production verification or worker replay.

## Scope

[PR #61](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/61) installed a private no-grants PostgreSQL fixture quarantine for active queued/running synthetic jobs. [PR #62](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/62) adds an HMAC-signed read-only source/PG reconciliation but uses one runner for its ephemeral signing key. This checkpoint extends **CI artifact verification** to another runner, without transporting any private signing key, without moving/authorizing real jobs and without giving runner B PostgreSQL, Redis or cPanel credentials.

## New contracts

- `apps/api/ci-active-quarantine-cross-runner.mjs`: strict `orbicore_ci_active_quarantine_ed25519_v1` envelope with `format,runId,headSha,nonce,sequence,rows,publicKeySpki,signature`. Node generates a fresh ephemeral Ed25519 key pair **in memory**, exports only the public DER/SPKI bytes, signs the deterministic JSON tuple with the run ID, head SHA and random 128-bit nonce, and returns separate SHA-256 hashes for public key and serialized envelope.
- Rows are a sorted, bounded (1–20) exact allowlist of **fixture job metadata** only: `id,organizationId,accountId,requestedBy,status,idempotencyKey,createdAt,startedAt,digest`. Status is only queued/running with correct time shape; each `ci-queue-*` idempotency key has an exact tenant prefix and per-row SHA-256 must match canonical fields. Extra keys, credentials, result or error payloads, duplicates and invalid identifiers are rejected before signing or verification.
- `scripts/verify-postgres-ci-active-quarantine.mjs`: after real PG16 private quarantine source/target parity and denied-source/PG tamper paths, reads the surviving two fixture records from the quarantined table, creates a signed evidence envelope, serializes it to `.data/ci/active-quarantine-cross-runner/evidence.json` mode 0600 and writes **only public** fingerprint, artifact checksum, signed sequence and row count to GitHub `GITHUB_OUTPUT`. The private key is neither written to the repository nor artifact nor stdout.
- `.github/workflows/ci-services.yml`: existing **runner A** (PG16 quarantine service job) publishes the non-secret artifact with `if-no-files-found: error`; new `ci-active-quarantine-independent-verifier` **runner B** uses `needs` job outputs, `actions/download-artifact@v7`, Node 24 and a separate checkout, with no PostgreSQL/Redis service, secret context or provider credentials. It verifies the entire artifact and expected current workflow `GITHUB_RUN_ID` / `GITHUB_SHA` through separate pin fields, then exports redacted success/failure summary. Runs in the same trusted GitHub Actions workflow but on an isolated host.
- `scripts/ci-verify-active-quarantine-evidence.mjs`: refuses any noncanonical JSON serialization, changed status, freshly recomputed forged row digest, missing/duplicate row, wrong signer, corrupted signature, unknown fields, changed SHA/run ID/sequence/count and a replaced public key, with zero ability to recreate operational work.

## Expected GitHub evidence

- Standard Node CI adds three tests for Ed25519 public-key pinned valid fixture, fake-only artifact shape, header/signer/row tamper and wrong consent/noncanonical rows.
- Hosted PG16/Redis integration workflow adds a **26th** independent verifier job, which must succeed **after** 25th producer job passes its existing serializable rollback, RLS and no-work-replayed checks. The new job's output must prove public-key and artifact checksum verification on a different runner, without any private signing material.
- All existing Node, PostgreSQL/Redis/Compose, Chromium and plan-task-ledger checks must remain green on the final PR head before merge. Actual tested head SHA/run URLs will be recorded after checks.

## Deliberate limitations

This is **public-key attestable CI synthetic metadata**, not proof that the quarantined job ever existed on a real hosting system, not a persistent externally anchored signer, not externally controlled release attestations, not operator-approved replay/resume, and **not** cross-store or cross-runner PostgreSQL/SQLite backup recovery. Producer and verifier run within the same GitHub workflow; an adversary able to alter both workflow code and trusted job outputs could substitute both evidence and pins. Private key exists only during the producer CI process, not in KMS/HSM, and the generated public key is pinned only by same-workflow job output. No live cPanel authorization. Canonical lifecycle stays ORB-004/016/017 `testing/integration_tested` and ORB-005 `in_progress/integration_tested`.
