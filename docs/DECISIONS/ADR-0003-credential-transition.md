# ADR-0003: Reversible SQLite scrypt → PostgreSQL credential transition

**Status:** proposed migration design; read-only Slice A compatibility verifier CI-tested, production cutover **not approved**  
**Date:** 2026-11-22  
**Owner task:** ORB-005 (dependent ORB-004 / ORB-016 / ORB-017)

## Context and observed boundary

The default HTTP application in `apps/api/server.mjs` authenticates against SQLite. It currently computes `scryptSync(password, salt, 64)` and stores a 16-random-byte salt encoded as 32 hexadecimal characters plus a 64-byte derived key encoded as 128 hexadecimal characters. Its `scryptSync` call uses implicit Node parameters: the parameters must be explicitly pinned and independently regression-tested **before** any migration verifier is accepted.

The existing `db/migrations/008_postgres_ci_auth_lifecycle.sql` and `009_postgres_ci_auth_audit.sql` accept **only** records tagged `ci_pg_bcrypt_only` and require the CI-only PostgreSQL adapter flag. Their bcrypt fixture accounts, loopback cookies, recovery-code flow and atomic tenant audit are **not** a production-ready SQLite scrypt verification path. The synthetic offline identity snapshot currently copies fixture verifier fields, but this must not be taken as authorization to export real verifiers or flip runtime reads.

There is no cross-database atomic transaction between SQLite and PostgreSQL. Production TLS/cookie, MFA key custody, entire SQLite v7 jobs/secrets/audit migration, tenant-scoped write roles, and off-host restore evidence are not complete. **SQLite remains the only authority** until every cutover gate below is independently verified.

## Decision and non-goals

1. **No plaintext export, bulk rehash, or verifier exposure.** Never export a password or recovery code in an API, job, CSV, log, audit, migration artifact, browser response, test fixture or AI context. Do not copy production SQLite password hashes into public PostgreSQL tables, read-only tenant roles, backup examples or the CI bcrypt fixture namespace. A legacy verifier may be read only by the existing authorized local authentication boundary and must not become an ordinary application result.
2. **Use a verified successful password reauthentication or an independently verified reset.** Before a PostgreSQL verifier is provisioned, authenticate the user with the existing SQLite verifier in a trusted server-side flow. The cleartext password is transient request input only: derive a fresh salt and versioned destination verifier in process memory and discard request material at the end of the request. Do not convert a stored scrypt output to a new password verifier, treat possession of a legacy hash as a login, or accept a previously authenticated cookie as sufficient to re-key a password without explicit reauthentication. For users who cannot reauthenticate, use a separately approved, non-enumerating recovery/reset flow rather than transferring a verifier.
3. **Version the destination verifier and fence reads.** A proposed private credential table must bind `organization_id`, immutable `user_id`, `credential_version`, `kdf`, reviewed `kdf_parameters`, `salt`, `verifier`, `source_version`, `verified_at`, and a monotonic credential epoch. The table must be unreadable by tenant readers and runtime job roles. Select a reviewed password KDF/parameter profile only after independent cryptographic and performance review; do not silently use the CI-only bcrypt marker for migrated credentials. RLS, SECURITY DEFINER ownership, default grants, schema search path and credential-access separation need negative tests against a real non-owner connection.
4. **Shadow writes are not an authority switch.** In an explicitly opted-in migration pilot, a successful **SQLite-authoritative** password reauthentication may write a private versioned PostgreSQL verifier, using a transaction and unique idempotency key. If this write fails, the user remains on SQLite; the request must not claim a migrated account. A PostgreSQL shadow record is *not* a second login authority and does not permit producing a PostgreSQL session. No automatic fallback from PostgreSQL to SQLite is allowed after cutover.
5. **Fence changes and sessions.** A password change, reset, disable, tenant move, role revocation or MFA enrollment/recovery during shadowing invalidates or increments the credential epoch and blocks the target verifier until reauthenticated. Before cutover, freeze or reconcile changes with audited change replay and equality proofs. Never migrate or replay existing SQLite session cookies as PostgreSQL sessions. Issue new TLS-only session cookies after target-side password *and* MFA verification; revoke the old session family under a documented transaction/revocation protocol.
6. **Tenant and anti-enumeration controls apply across both stores.** Resolve tenant/user identity from trusted server-side records, never a client-provided tenant. Do not reveal whether an email exists, whether the account has migrated, or which verifier rejected a login. A future cross-tenant login-failure stream needs keyed pseudonymous identifiers with externally held/rotatable HMAC key, not unsalted SHA-256(email), and bounded distributed attempt limits. Do not label unknown-user events as authenticated tenant audit events.
7. **Keep full audit and MFA barriers.** A successful target authentication must atomically write the redacted, hash-chained tenant audit event with session changes; failure must roll back the session. TOTP encrypted key custody, WebAuthn assertion/challenge state, recovery-code one-time use, verified notification channels and emergency recovery must have separate migration tests. Recovering the password alone must not bypass MFA or authorize hosting operations.
8. **No production toggle in this ADR.** New runtime wiring, feature flags, SQL roles, migrations, data copies, deployments, account recovery and external provider operations require separate PRs and explicit environment-specific approval. Nothing in this document grants permission to import real accounts.

## Proposed reversible migration lifecycle

| State | Authority for login | Entry condition | Failure / rollback |
|---|---|---|---|
| `legacy_only` | SQLite only | Existing active user | Continue current SQLite login |
| `shadow_reverified` | SQLite only | Fresh legacy password verified; guarded PG credential write committed at matching epoch | Discard/disable shadow verifier on mismatch or failure |
| `shadow_proven` | SQLite only | Identical identity/tenant/MFA mapping, revocation and audit replay proven; cross-store reconciliation complete | Stop pilot and return to legacy-only |
| `cutover_eligible` | SQLite only | Recoverable off-host backups, restore tests, full jobs/secrets/history migration, distributed throttle, trusted PG roles, TLS/CSRF and MFA verified | No switch; repair blockers |
| `pg_authoritative` | PostgreSQL only | Explicit operator-approved cutover at a fenced epoch, target health and credential proofs, new PG sessions issued | Follow tested rollback playbook; no silent SQLite fallback |
| `rollback_pending` | Fail closed to new auth until explicit authority selection | A target incident or failed consistency gate | Restore verified snapshot and reconcile epoch/revocations without reactivating revoked credentials |

Transitions must be durable, monotonic, tenant-scoped and observable. Retain a read-only migration journal and an audit sequence for reconciliation; avoid exposing plaintext verifiers in the journal. Rollback must not reenable a disabled user, consumed recovery code, revoked session, or old password. If equivalent revocation state cannot be proven, require the affected user's reauthentication/reset and invalidate both session families rather than guessing.

## CI-only invalidation follow-up (2026-11-23)

[Migration 012](../../db/migrations/012_postgres_ci_shadow_epoch_fence.sql) and [file-backed SQLite epoch outbox / hosted replay proof](../TEST_EVIDENCE/2026-11-23-orb-005-ci-epoch-reconciliation.md) validate monotonic revoke-only synthetic shadow invalidation across SQLite rollback, PostgreSQL failures and post-PG-commit/pre-SQLite-ack interrupted delivery. The test also checks source password reset, disabled flags, MFA placeholder flags, role revoke, tenant mismatch, and out-of-order epoch replay. This reduces the CI-only gap but **does not solve the production cutover gate**: source event journal is test-only, not wired to real mutation handlers or actor audit; PG cannot attest event authenticity; there remains a cross-store window and no production reader/fail-closed epoch equality check. No new PG authentication authority.

## Required implementation slices (ordered)

**Slice A — verifier contract and threat tests (no writes):** the separate [compatibility verifier](../../apps/api/legacy-scrypt-verifier.mjs) and [six unit cases](../../tests/legacy-scrypt-verifier.test.mjs) now pin the historical Node scrypt format with [hosted CI evidence](../TEST_EVIDENCE/2026-11-22-orb-005-scrypt-compatibility.md). **Remaining:** tenant/user provenance and end-to-end HTTP/SQL/log confidentiality controls; do not wire the helper into normal login. No production SQL auth functions were changed.

**Slice B — restricted shadow credential storage:** [CI-only migration 010](../../db/migrations/010_postgres_ci_shadow_schema.sql) and [hosted deny-all proof](../TEST_EVIDENCE/2026-11-22-orb-005-pg-ci-shadow-schema.md) establish a *placeholder-only* private schema, tenant FK, positive epochs, rerunnable DDL, FORCE default-deny RLS, real non-owner negative role/tenant access, and forced rollback. **Not yet implemented:** approved real-verifier storage, active shadow writer/read-verifier grants, actual password or source credential handling, or per-user epoch reconciliation.

**Slice C — explicit reauthentication pilot:** the [CI-only implementation](../../apps/api/postgres-ci-credential-shadow.mjs), [private migration 011](../../db/migrations/011_postgres_ci_reauth_shadow.sql), and [hosted source-password / non-owner rollback proof](../TEST_EVIDENCE/2026-11-22-orb-005-ci-reauth-shadow.md) now check synthetic SQLite passwords before creating new separately salted test-profile scrypt verifiers. Negative checks cover tenant/identity mismatch, source epoch, disabled/MFA state, idempotency and PG faults. **Remaining:** real source mutation epoch hooks, audited distributed invalidation/reconciliation, password-reset/MFA races, production KDF review and source+target recovery. No login/read-routing or real accounts are enabled.

**Slice D — complete runtime authority cutover:** blocked until SQLite v7 jobs, secrets, audit, key provenance/decryptability, MFA/recovery/passkey, notifications, production HTTPS cookies, distributed throttling, full write RLS, off-host backup/restore and explicit rollback drills pass. Do not put `pg_authoritative` into ordinary API routing earlier.

## CI-only source provenance and keyed failure audit (2026-11-23)

[Source event attestor](../../apps/api/ci-source-event-attestation.mjs), [keyed failure-audit helper](../../apps/api/ci-keyed-auth-failure-audit.mjs) and [13-job hosted evidence](../TEST_EVIDENCE/2026-11-23-orb-005-ci-hmac-auth-provenance.md) now test externally injected HMAC-SHA256 with rotating keys, typed/tenant-bound signed source event claims, tamper denial before PG reconciliation, and pseudonymized, tenant-independent generic rejected-login evidence including key-rotation fail-closed behavior. These do **not** prove authorized real actor provenance, source event completeness (deletion protection), actual HTTP response timing parity, distributed throttle, key custody, or a production migration. No PG authentication read routing or real account changes.

## CI-only actor authorization and independent source witness (2026-11-23)

A [synthetic mutation actor authorization](../../apps/api/ci-source-mutation-authorization.mjs) helper and [private PostgreSQL witness migration 013](../../db/migrations/013_postgres_ci_source_witness.sql) have [hosted 14-job evidence](../TEST_EVIDENCE/2026-11-23-orb-005-ci-actor-witness.md). Versioned v2 source HMAC binds actor identity to event/tenant/source epoch, while a separate PG table retains metadata with an append-once restricted non-owner role. The trusted CI inspector identifies deleted witnessed events, missing/unmatched witnesses, malformed signatures and local source epoch regressions. **Not closure:** signer compromise, event suppression before external witness, coordinated source epoch+outbox tampering, privileged target owner, actor MFA, externally auditable key custody, actual HTTP integration and operator-approved cutover remain open.

## CI-only detached witness checkpoint and fail-closed inspector (2026-11-23)

[Detached CI witness signer](../../apps/api/ci-detached-witness-checkpoint.mjs), [source/target consistency probe](../../apps/api/ci-shadow-readiness-probe.mjs), and [15-job hosted evidence](../TEST_EVIDENCE/2026-11-23-orb-005-ci-detached-readiness.md) validate separately pinned HMAC metadata, normalized witness snapshots, rollback detection, event completeness, PG epoch projection and absence of stale shadow drafts. The mock auditor checkpoint is merely a **second writable file within the same CI runner**, not operationally independent WORM, vault, object-lock retention or off-host recovery. Its test may report synthetic fixture consistency but structurally refuses all production login authority. Real external audit custody, source-to-witness atomicity/undetected pre-anchor suppression, production MFA authorization, cross-store recovery and approval remain blocking.

## Acceptance and adversarial evidence gate

- [x] Exact legacy KDF outputs reproduced using synthetic Unicode/ASCII/empty-password fixtures, UTF-8 hex-text versus decoded salt checks, fixed parameters and timing-safe comparison; [CI evidence](../TEST_EVIDENCE/2026-11-22-orb-005-scrypt-compatibility.md).
- [ ] Malformed salt/verifier, unsupported versions, oversized input, disabled user and wrong tenant fail closed without stack traces or verifier exposure.
- [ ] Wrong-password and unknown-user responses are indistinguishable at the API contract level; attempt throttling and keyed pseudonymization have independent negative tests.
- [ ] Fresh successful reauthentication produces a new versioned PG verifier; bulk hash-copy and hash-as-password attempts are explicitly rejected.
- [ ] Real non-owner SQL credentials cannot select verifier/salt, use old fixture login grants, bypass tenant scope or create unaudited sessions.
- [ ] Simulated PG outage, interleaved password reset/disable, duplicate reauth and crash between SQLite verification and PG shadow write preserve SQLite authority.
- [ ] Target session creation and audit event remain atomic; forced audit failure yields no authenticated session.
- [ ] MFA/TOTP/passkey, recovery-code use and key rotation continuity are proven across cutover; no old cookie works after promotion.
- [ ] Reproducible off-host backup/restore and loss/recovery drills include users, jobs, secrets, migrations, audit history and credential epochs.
- [ ] Two-tenant isolation, authorization revocation, roll-forward and rollback drills complete on separate deployments with consistent epochs.
- [ ] A human/operator explicitly approves the actual production migration plan, blast radius, maintenance mode, rollback window, dependencies and secret custody.
- [ ] All test results cite exact head SHA, CI workflow, executed commands, artifacts and limitations in `docs/TEST_EVIDENCE/`; no assertion of production success from synthetic tests.

## Consequences and checkpoints

This approach requires users to reauthenticate or reset; dormant accounts cannot silently become PostgreSQL-ready. That cost is intentional: the project must not expand access to legacy password hashes, claim a bcrypt fixture proves scrypt compatibility, or cross an unverified security boundary. Inactive accounts should remain disabled for target login pending verified recovery, not become inaccessible without a recovery path.

**Current checkpoint:** the migration design remains proposed, while a separate read-only scrypt compatibility helper and six synthetic unit tests passed [hosted standard and browser CI](../TEST_EVIDENCE/2026-11-22-orb-005-scrypt-compatibility.md). No changes to default SQLite HTTP login, PostgreSQL schema/authentication, user data or actual migration; no real credentials or authority cutover. ORB-005 stays `in_progress / integration_tested`; the broader security gates are open.
