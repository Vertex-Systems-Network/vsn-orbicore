# ORB-004/005/016/017 — signed quarantine replay-policy dry-run without execution

**Date:** 2026-11-23 UTC. **Status:** Feature PR checks pending; no claim of successful production recovery.

## Purpose

Previous [cross-runner Ed25519 fixture attestation](2026-11-23-orb-004-cross-runner-quarantine-attestation.md) establishes that independently downloaded metadata from CI-only `queued`/`running` jobs has not changed between the producer and second runner, subject to same-workflow trust limitations. A valid signature says *nothing* about whether any job can safely resume. This checkpoint encodes a concrete **denial-by-default policy** and makes that distinction testable without writing production code to execute it.

## New contract

- `apps/api/ci-active-quarantine-replay-preflight.mjs`: requires GitHub Actions, `ORBICORE_CI_ACTIVE_QUARANTINE=1`, exact `ci_fixture_active_jobs_quarantine_no_replay` consent, and independent metadata signature/pin verification.
- Only strict digest/status-based outputs are returned. A `queued` row is `manual_review_only`, not ready-to-execute; a `running` row is `isolate_and_investigate`, because prior provider effects and source worker lease ownership cannot be proven. No IDs, idempotency keys, tenant names, provider credentials, payloads or executable instructions in policy dispositions.
- **All** outputs have `executable:false`, `replayAuthorized:false`, `jobOutboxWrites:0`, `redisSignals:0`, `providerCalls:0`. Caller-provided `approved:true`, `forceReplay:true` or `externalOperatorApproved:true` is ignored, not trusted.
- Seven production prerequisites remain **missing** by design: owner-authorized scoped replay, externally custodied signing keys, durable source/target fencing, crash/lease evidence, authenticated tenant/worker role authority, provably idempotent provider effects and rollback, and independently approved/recorded operator actions.
- `tests/ci-active-quarantine-replay-preflight.test.mjs` checks valid queued/running signed fixture, result shape and no side effects; tamper/foreign SHA/run; invalid consent; fake approval fields. The existing *second separate hosted runner* calls the same policy after verifying the signed artifact. No additional runner or service secrets required.

## Expected CI evidence

- GitHub Actions standard Node tests/security/build/plan, full PG16/Redis7 services (including standalone producer and independent verifier runner), Chromium and trusted PR ledger must all pass on the final PR head.
- Independent runner verifies two synthetic jobs (one queued, one running) are classified without generating an executable job or source/target database work. Existing PG16 source/target parity, forced rollback and read denial remain in place.

## Limitations

This is **not** production recovery, an externally approved replay protocol, transactionally fenced source/target migration, proof of provider-effect idempotency, long-lived key custody, or an emergency runbook authorization. It does not authorize the user, operator, worker or GitHub runner to resume real jobs. No production credentials, API routes, SQL writes, Redis signals, cPanel access or destructive operations were added. Lifecycle remains ORB-004/016/017 `testing/integration_tested`, ORB-005 `in_progress/integration_tested`; ORB-006/019 require separately scoped owner-approved live cPanel access.
