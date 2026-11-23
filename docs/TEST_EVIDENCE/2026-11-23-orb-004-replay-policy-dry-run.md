# ORB-004/005/016/017 — signed quarantine replay-policy dry-run without execution

**Date:** 2026-11-23 UTC. **Status:** Functional PR head `0c47b0ec6dbd26210a62f330686f28732762f190` passed all hosted checks; final documentation-head CI/merge pending. No production recovery.

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

## Measured hosted CI result

- [PR Node CI #45166754952](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45166754952) passed **154/154 Node tests, zero failed**, including the three new non-executable policy tests, with existing typecheck/lint/plan/security/build/smoke gates. [Branch CI #45166696775](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45166696775) also passed at the same SHA.
- [PostgreSQL16/Redis7 service integration #45166754785](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45166754785) passed **26/26 hosted jobs**, including prior private PG quarantined source/target rollback/RLS/no-public-job-outbox checks and the **separate runner B** public-key verifier extended with policy dry-run assertions. In runner B, the two signed fixtures remained queued→manual review and running→investigation; the returned policy refused authorization and produced no executable payload, Redis signal, PG outbox write or provider effect. All other service jobs passed unchanged.
- [Chromium/browser #45166754852](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45166754852) and [trusted PR task ledger #45166754993](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45166754993) both passed on the same functional SHA. No task lifecycle promotion: canonical 6 verified, 9 testing, 3 in progress, 2 blocked.
- **Limitation:** The two generated jobs are mock CI metadata from an isolated runner; no real provider, external operator, production queue, durable authority or authenticated approval mechanism has been exercised. The policy intentionally never authorizes replay.
