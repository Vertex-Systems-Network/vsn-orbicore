# ORB-005 — CI-only signed source provenance and HMAC login-failure privacy

**Date:** 2026-11-23  
**PR:** [#27](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/27)  
**Functional tested SHA:** `01955da6c7c1f626df4b1034c39a6e1e2a80dba5`

## Real hosted verification and evidence

- [Service Integration #45061717879](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45061717879) — **success, all 13/13 jobs**, including new PostgreSQL 16 HMAC source-event / SQLite keyed audit test, original PG source-epoch reconciliation, PostgreSQL auth/audit/tenant jobs, Redis parity and disposable Compose persistence.
- [PR CI #45061717860](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45061717860) and [branch CI #45061693482](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45061693482) — **success** at tested SHA; locked dependencies, tests, lint, security audit, CycloneDX SBOM, npm audit, build, smoke and doctor.
- [Chromium virtual WebAuthn/browser #45061717841](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45061717841) — **success** at tested SHA; not physical authenticator or production identity.
- [Artifact #14769169934](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45061717879/artifacts/14769169934), named `orb-005-ci-hmac-privacy-provenance`; reported digest `sha256:96ad8b6c20707cef9ac50c8068d260a4b003530d12216da4a0a73ce3d6bee2ca`. Contains a minimal boolean-only proof record, not a password/key/verifier.
- Executed in GitHub Ubuntu, Node 24, disposable PostgreSQL 16, file-backed SQLite. The PG job applies base identity and opt-in migrations 001–006, 010–012. Source and audit HMAC keys were generated with `randomBytes(32)` **at test execution** and kept only in process memory. No production account, live provider, actual key custody system, remote service or external identity was used.
- Evidence and documentation were committed *after* the functional SHA: final PR HEAD and postmerge `main` checks must be verified independently before declaring completion.

## Observed signed SQLite source-event properties

1. A new opt-in `createCiSourceEventAttestor` computes HMAC-SHA256 over a domain-separated canonical array of random event ID, organization, user, source epoch and revocation reason. The signing key is externally injected, minimum 32 bytes; only a non-secret key ID and MAC are persisted. Source event, epoch and synthetic password/disable/MFA/role change commit in the same SQLite transaction. No default HTTP handler imports the attestor.
2. The opt-in reconciler checks event MAC and source user/organization/epoch **before** invoking the existing PostgreSQL SQL revoke-only function. Tampering with a signed event reason failed before any PG fence was created. A different key of the same ID failed. An unsigned attempted source mutation failed and the SQLite transaction rolled back.
3. An injected failure **after PostgreSQL committed but before SQLite acknowledged** left an older shadow verifier invalidated and a pending event. Closing/reopening SQLite, then replaying the same event with the original signing key, safely acknowledged it without issuing sessions or re-enabling a verifier.
4. Retaining the previous source MAC key allows pending event processing after key rotation; events signed by the new active key carry its distinct ID. A rotated keyring cannot retroactively verify old events without retaining old keys.

## Observed keyed login-failure privacy properties

1. A separate gated `ci_auth_failure_events` SQLite table records only random event ID, key ID, `HMAC-SHA256` pseudonym, integer timestamp and generic outcome; it has **no email, username, password, tenant ID, user ID, IP, recovery code, session token or source account-existence columns**.
2. Known-account/wrong-password and unknown-account synthetic rejection calls used the **same returned 401 `invalid_credentials` contract**. After configured repeated failures, the 429 `auth_rate_limited` contract was independent of whether the input corresponded to an existing user. The unit tests check conservative ASCII input canonicalization and malformed input using one keyed shared bucket.
3. The HMAC source key is domain-separated from the auth-failure key. The test inspected the stored rows to confirm plain input emails, synthetic password, user ID and tenant ID were absent. Same email with case/whitespace variants produced the same keyed pseudonym; different identifiers produced different pseudonyms. No raw secret was output.
4. Key rotation retained old pseudonyms for the live attempt window. Dropping the old key while its records remained in the live window triggered a generic **fail-closed audit unavailable** error even for unknown accounts. The SQLite test also injected an audit-write fault: the insert rolled back, returned a generic unavailable error and did not leak the submitted identifier. File-backed SQLite close/reopen preserved quota state; after the explicit expiry time, old keys could be dropped without silently resetting active quota.

## Limits, not verified, and necessary next gates

- **All modules are synthetic GitHub-only and not imported by normal HTTP login.** No real login is currently logged via this HMAC adapter, no real source event is signed, no production credential reader validates the resulting fence, and no claim about HTTP response *timing* parity or multi-instance distributed quota is made.
- The signature does **not** prevent deletion of pending SQLite events, a compromised trusted source signer, a revoked/corrupted signing key or a privileged PG reconciler forging denial-only events. PostgreSQL cannot independently prove that a signed source event came from authorized SQLite mutation. No append-only WORM checkpoint or externally anchored outbox digest is tested.
- Account-only throttle can be abused to deny access; distributed attack protection requires independent per-source/global/device/network budgets, and the current fixture is file-backed SQLite, **not** a scalable distributed rate limiter. Retention, privacy/erasure, monitoring and externally held key rotation remain unimplemented.
- The deterministic injected crash does not prove actual power failure, corruption, off-host backup/restore or operational key availability. No real TOTP/passkeys/recovery secret migrations, production TLS cookies, full SQLite v7 secrets/jobs/history migration or fail-closed cutover.
- ORB-005 stays `in_progress/integration_tested`. Next: independently attest authorized mutation identity/privileges, anchor source event completeness, prove non-enumerating HTTP failure behavior with distributed throttling and exercise fail-closed watermark checks before any real production credential cutover.
