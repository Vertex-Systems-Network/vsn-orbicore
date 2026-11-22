# ORB-005 — CI-only SQLite password reauthentication to PostgreSQL shadow draft

**Date:** 2026-11-22  
**Pull request:** [#25](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/25)  
**Functional tested SHA:** `91d00a8867f434cdea15e48af506b0b62959e527`

## Hosted GitHub verification

- [Service Integration #45057460264](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45057460264) — **success**, **11/11 jobs** including the new disposable SQLite source reauthentication → PostgreSQL 16 shadow-draft job; previous PostgreSQL identity/auth/MFA, Redis and Compose regression jobs passed at the same SHA.
- [PR standard CI #45057460320](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45057460320) and [branch standard CI #45057456940](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45057456940) — **success** at the same SHA. Standard workflow executes `npm ci`, `npm test`, `npm run lint`, `npm run security:check`, SBOM export, `npm audit --audit-level=high`, `npm run build`, `npm run smoke`, `npm run doctor`.
- [Hosted Chromium WebAuthn/browser #45057460255](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45057460255) — **success** at the same SHA. This remains virtual/synthetic browser evidence, not production credential migration or physical authenticator proof.
- [Hosted synthetic reauthentication artifact #14767508793](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45057460264/artifacts/14767508793) named `orb-005-ci-reauth-shadow`; GitHub-reported ZIP digest `sha256:01733c06bd10fe522b0c7585f077ea5d482ff45d016ef8ee66095f225d7e4cb9`.
- Hosted environment: GitHub Ubuntu, Node 24, PostgreSQL 16 service container. `db/postgres-schema.sql`, migrations `001`–`006`, `010`, and **`011` applied twice** with `PGOPTIONS=-c orbicore.ci_shadow_fixture=enabled`; opt-in `GITHUB_ACTIONS=true`, `ORBICORE_CI_SYNTHETIC_SHADOW_SCHEMA=1`, `ORBICORE_CI_SYNTHETIC_REAUTH=1`. `node scripts/verify-postgres-ci-credential-shadow.mjs` writes a boolean-only/nonsecret JSON artifact. Nothing was deployed or tested against a live hosting provider.
- This evidence file and accompanying project-state edits were appended after the functional tested SHA. Recheck the **final** PR head and postmerge `main` CI independently; do not conflate earlier head runs with later documentation commits.

## Verified synthetic behavior

1. `apps/api/postgres-ci-credential-shadow.mjs` is **not imported by default HTTP or worker runtime**. It refuses operation without the explicit GitHub-only flags. It validates the source SQLite user ID and fixture email, existing tenant and role, active/unlocked state, disabled/MFA flags, source-epoch sidecar and a **fresh source password** using the pinned legacy scrypt verifier. Wrong, unknown, malformed or stale inputs produce no PG draft.
2. After successful source authentication, the CI adapter creates a **new random 24-byte binary salt** and derives a separate `scrypt N=32768,r=8,p=3` 64-byte verifier. It sends only that derived verifier/salt and source identity/epoch to a restricted non-owner PostgreSQL SQL function, never the legacy hash or plaintext password. Source SQLite remains the login authority.
3. `db/migrations/011_postgres_ci_reauth_shadow.sql` is **re-runnable and expressly CI-only**. It creates a private `orbicore_ci_shadow.reauth_drafts` table with tenant+user FK, positive source epoch, fixed KDF profile, strict salt/verifier shapes, tenant-scoped idempotency uniqueness, and one pending record per user. `ENABLE` + `FORCE ROW LEVEL SECURITY` with **no policies** denies direct non-owner table reads/writes.
4. A disposable actual PostgreSQL `LOGIN NOINHERIT NOBYPASSRLS` role must explicitly `SET LOCAL ROLE orbicore_ci_shadow_writer` and can invoke only the fixed `SECURITY DEFINER` staging function, with **no direct SELECT or INSERT** privilege on the private table. Direct access and direct SQL function invocation outside the intended role are rejected.
5. The test proved source/target email mismatch rejection, independent tenant rows, wrong-password denial, stale source epoch denial, duplicate retry denial, disabled-user denial, MFA-enabled source denial, and an injected PostgreSQL insert-check failure that **rolls back the attempted PG draft** while preserving the source SQLite password hash and epoch. The same synthetic source succeeds after fault removal.
6. No new session, token, cookie or target-side login credential acceptance path exists; persisted shadow drafts are **inert** and cannot grant authorization.

## Remaining blockers / explicit negative claims

- This is **not a production migration**. The source epoch is an **isolated CI-only SQLite table** and is not updated by real password changes, reset, account disable, MFA enrollment or team policy changes. A shadow verifier can become stale immediately after a later source mutation. PostgreSQL shadow rows are therefore prohibited as an authentication authority.
- SQLite transaction+PostgreSQL transaction are not atomic together. The CI adapter holds a SQLite write lock during a PG commit only as a bounded disposable test; it does not solve crash recovery or distributed consistency. A PostgreSQL privileged superuser/SECURITY DEFINER owner remains able to read fixture verifiers. Runtime role governance is not proven.
- The trusted writer function checks PG fixture identity but **cannot independently attest a SQLite password verification**. A compromised trusted SQL writer could stage a synthetic verifier. Do not grant this role in production or treat PG draft existence as evidence that the user controls the account.
- The test KDF is an **experimental fallback profile**, not approved for production. Argon2id preference, parameter benchmarking and DoS budget, strong pepper/key management, Unicode normalization policy and hash rotation are open. See [dated KDF research](../RESEARCH/2026-11-22-synthetic-credential-reauth-kdf.md).
- Missing independent security gates: complete tenant-independent keyed login-failure audit, real TOTP/passkey key custody and recovery, TLS/Secure-cookie/proxy edge, session revocation, fully trusted non-bypass runtime roles, full SQLite v7 job/secret/audit/key import, off-host backup/restore and reversible cutover. No real credentials, provider endpoints or production accounts were used.

## Next action

Keep `ORB-005 in_progress / integration_tested`. Next work should design and prove a **durable cross-store source-credential epoch and invalidation/reconciliation protocol** covering password change/disable/MFA/recovery races, with audit preservation and failure injection, still synthetic-only. Separately design keyed anti-enumeration for unknown-email login failures. Do not enable PostgreSQL authentication or production provider operations.
