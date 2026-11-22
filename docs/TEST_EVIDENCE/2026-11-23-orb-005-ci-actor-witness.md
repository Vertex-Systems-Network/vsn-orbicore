# ORB-005 — CI-only authorized mutation actors and independent source event witness

**Date:** 2026-11-23  
**PR:** [#28](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/28)  
**Functional tested HEAD:** `70a6de2b5341d04b60b15c8f345149e9534d01cc`

## Hosted GitHub verification

- [Service integration #45062773129](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45062773129): PostgreSQL 16, Redis/Compose and the new actor/witness test. **14/14 service jobs successful** at functional head.
- [PR standard CI #45062773114](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45062773114) and [branch standard CI #45062750068](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45062750068): **success** at functional head. Locked install, tests, lint, security, SBOM, npm audit, build, smoke and doctor.
- [Hosted Chromium WebAuthn/browser #45062773103](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45062773103): **success** at functional head; virtual authenticator only.
- [Synthetic evidence artifact #14770496072](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45062773129/artifacts/14770496072), name `orb-005-ci-actor-witness`; GitHub-reported digest `sha256:e5b0f8dd6c677362690bcf366380b0f15cb92affb7a2461a19c594a91c6d7dc3`. Contains booleans, not private credentials.
- Real hosted PostgreSQL 16 service (base migrations 001–006, private 010–013 with 013 applied twice), Node 24, generated synthetic identities/passwords and file-backed SQLite. The PG role is a disposable **real non-owner, NOINHERIT, NOBYPASSRLS** login with membership in a dedicated NOLOGIN witness role.
- Evidence and documentation were committed after functional tested SHA. Recheck docs-head and post-merge `main` workflow; do not conflate earlier runs with final-head completion.

## CI-only implementation and measured tests

1. `ci-source-mutation-authorization.mjs` verifies a **fresh synthetic legacy SQLite password** inside the source mutation transaction, the actor's active/non-MFA-required fixture state, actor–target same tenant, and reason-specific rights: self-service password reset/MFA placeholder enrollment versus owner-only disable/role revoke of a non-owner. Negative tests reject bad password, unknown actor, cross-tenant actor, viewer/operator privileges, owner self-disable, and disabled/MFA-required actors. Invalid operations leave source epochs and event counts unchanged.
2. `ci-source-event-attestation.mjs` now signs actor IDs into a **v2** domain-separated source HMAC for the opt-in actor mode, preserving existing **v1** synthetic tests in earlier workflows. A different actor ID or omission of that ID fails v2 verification. No signing secret or submitted password is written to SQLite, PG, CI artifacts, or ordinary logs.
3. PostgreSQL `013_postgres_ci_source_witness.sql` creates private `source_event_witnesses` metadata (tenant, subject, source epoch, event ID, key ID, HMAC and actor ID) with both tenant-subject and tenant-actor composite FKs, append-once epoch and unique event IDs, **FORCE RLS with no policies**, and a fixed `SECURITY DEFINER` witness function callable by an EXECUTE-only NOLOGIN role. Non-owner direct SELECT/DELETE were rejected; conflicting attempts to rewrite an anchored epoch returned false while repeat identical writes were idempotent.
4. The CI-only trust-boundary inspector compares a **separately retrieved PostgreSQL witness snapshot** with every source SQLite credential epoch and its signed outbox event. It returned **incomplete** for an unwitnessed committed event, a deleted *previously witnessed* event, changed event actor/MAC, a source-epoch regression, and deleted PostgreSQL witness. After restoring source event consistency it returned `complete:true`. The new witness still cannot be used to authenticate.
5. A deterministic exception **after PostgreSQL witness commit** was recoverable by repeating the witness append with the same event and checking the unchanged event count. File-backed SQLite close/reopen preserved the local source history and independently witnessed metadata.
6. After an event was deleted *before witness capture* but its SQLite epoch remained elevated, the local epoch/outbox scan still reported incomplete. This is **not** a proof against simultaneous tampering with both unwitnessed SQLite outbox and local epoch.

## Critical limitations and next gates

- **No production source authorization.** The source actor proof is synthetic password-only and expressly rejects MFA-enabled actors; it does not validate real TOTP/passkey MFA, password reset recovery policy, sessions/CSRF, audited admin delegation, separation of duties or production tenant roles.
- **No indestructible witness:** PG witness capture happens after source SQLite commit and is not atomically linked across databases. A malicious insider could delete both unwitnessed source event and its epoch, or compromise the source HMAC signer. A privileged PG owner could modify/delete witness rows; the non-owner role cannot. A compromised PG witness writer may forge denial-only metadata (cannot grant login). PostgreSQL SQL does not independently validate source HMAC or trusted actor authorization.
- The snapshot inspector is a **CI-trusted test harness** that reads PG metadata via the disposable administrative connection; there is **no production read API, independent external witness custody or cutover authority check**. No real WORM archive, external anchor, live actor proof, distributed quota, HMAC key vault, power-loss recovery, cross-region backup or off-host restore tested.
- Missing non-enumerating production HTTP auth boundary, password/MFA/reset mutation integration, full SQLite v7 jobs/secret/audit migration, session/key provenance and human-approved rollback/cutover. No PostgreSQL credential authority or real provider operations were enabled. **Keep ORB-005 `in_progress / integration_tested`.**
- **Next slice:** independently anchored source completeness with fail-closed missing-witness readiness proofs, privilege-bound actor/MFA contract in a production-shaped test seam, and off-host recovery/key custody tests; no production auth switch.

