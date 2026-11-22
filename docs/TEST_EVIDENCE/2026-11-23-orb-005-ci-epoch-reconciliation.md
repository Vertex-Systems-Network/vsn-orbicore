# ORB-005 — Hosted CI-only source credential epoch and PG shadow invalidation

**Date:** 2026-11-23. **PR:** [#26](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/26). **Functional tested head:** `50ab3c6097693c94ef11dce600a927c407c2e03e`.

## Observed GitHub Actions checkpoints

- [Service Integration #45059912165](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45059912165) — **success, 12/12 hosted jobs** at functional SHA. This includes dedicated PostgreSQL 16 `postgres-ci-epoch-reconciliation`, previous PostgreSQL identity/RLS, source reauthentication shadow, login/MFA, audit, outbox, Redis and Compose persistence regression jobs.
- [PR CI #45059912092](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45059912092) and [branch CI #45059891209](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45059891209) — **success** at the same SHA. Standard repository verification performs locked install, Node unit tests, lint, security/SBOM/audit, build, smoke and doctor.
- [Chromium browser/WebAuthn #45059912164](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45059912164) — **success** at the same SHA; virtual authenticator only.
- Uploaded non-secret proof [artifact #14769181659](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45059912165/artifacts/14769181659) `orb-005-ci-epoch-reconciliation`; GitHub-reported artifact digest `sha256:b796d3989503a381b781093da7c17d64d5bba9aeeb586cbfa40a1319b86ee971`.
- Hosted verification used Node 24, a fresh PostgreSQL 16 CI service and **file-backed synthetic SQLite**. PostgreSQL migrations 001–006, 010, 011 and new 012 were applied, new migration **twice** to prove repeatability. No live provider or production auth.
- This evidence and task-state documentation were appended *after* functional SHA. Verify final docs-head and postmerge `main` checks separately.

## Measured synthetic security and reliability properties

1. New gated `apps/api/postgres-ci-credential-invalidation.mjs` creates **CI-only** `ci_source_credential_epoch` and `ci_source_credential_outbox` tables, not imported by `apps/api/server.mjs`. A single SQLite `BEGIN IMMEDIATE` transaction changes a synthetic password, account disable flag, MFA-enabled placeholder flag or role and increments the epoch **together with a non-secret pending event**. Injected precommit exception rolled back password change, epoch and event.
2. New `db/migrations/012_postgres_ci_shadow_epoch_fence.sql` creates `orbicore_ci_shadow.source_epoch_fences`, a tenant/user-bound monotonic high-water mark with default-deny forced RLS. A separate `NOLOGIN NOINHERIT NOBYPASSRLS` reconciler role receives **only EXECUTE** on a fixed revoke-only SQL function, never credential table read/write grants. Actual restricted PostgreSQL logins rejected direct read of the fence and verifier.
3. Reconciliation obtains `FOR UPDATE` on the same synthetic PG users row that source reauthentication staging locks `FOR SHARE`. The new staging `BEFORE INSERT` trigger checks the confirmed source epoch and rejects stale verifier drafts. When a later epoch is applied, all earlier still-pending shadow drafts are atomically set `invalidated`, and older replays cannot decrease the fence.
4. A **real PostgreSQL CHECK failure** rejected an invalidation and rolled back the PG fence/revocation transaction; the SQLite event stayed pending. Injected crash **before PG commit** also preserved pending source event. A **post-PG-commit/pre-SQLite-ack interruption** left a committed fence with an unacknowledged source event; after SQLite database close/reopen, replay returned an idempotent acknowledgement without re-enabling any shadow verifier.
5. A newer source epoch applied before an older pending event remained the high-water mark; older event replay acknowledged without regressions. Wrong tenant/user function call returned false, and tampering with event organization was rejected by source provenance guard before PG invocation; later correction recovered.
6. Four disposable tenant/users and separate newly derived synthetic verifiers tested; no real password/verifier bytes were printed or stored in artifacts, no PostgreSQL session issued, no default HTTP login code touched, no real provider consulted.

## Non-goals and remaining blockers

- **Not a distributed SQLite/PG transaction.** The SQLite-to-PG invalidation gap remains, and a pending old shadow draft could exist until reconciliation. **No runtime PG login authority is enabled; no runtime reader trusts shadows.** A future production cutover must fail closed while there are pending or uncertain source epochs and prove equality/rollback first.
- File-backed reopen and deterministic injected errors do **not** prove SIGKILL during fsync, OS crash/power loss, off-host backup/restore, disk corruption or failover. The test did not exercise a live password reset/MFA endpoint.
- The source tables are **test-only fixtures**; real password changes, disables, MFA key enrollment/recovery and policy changes are not wired to the journal. The synthetic MFA flag does not provision or rotate MFA secrets. A compromised reconciler SQL principal can forge a **revoke-only** event causing denial (not authorizing new access). SQL alone cannot attest a SQLite source event.
- Outstanding: authenticated source-provenance/audit/key ownership, production role governance, origin privacy and rate limiting, whole SQLite v7 jobs/secrets/recovery migration, frozen/fenced cutover protocol, production TLS cookie/session revocation and off-host restore drills. ORB-005 stays `in_progress`, verification `integration_tested`.

## Next bounded slice

Model end-to-end **source mutation provenance** and tenant-independent **keyed non-enumerating failure audit**, plus production-grade epoch/watermark cutover gates under full fault-injection scenarios. Do not enable any real PostgreSQL credential authority without those independent reviews and operator authorization.
