# Security threat model — Phase 0/1 baseline

## Assets and trust boundaries

Assets: hosting credentials/tokens, customer site/database/email data, migration archives, object-store keys, tenant inventory, audit trail, job integrity, DNS authority and AI prompts. Boundaries: browser/API, tenant/API, API/worker queue, worker/provider, worker/object storage, local install/operator secrets, and optional external model provider.

## Threats and required mitigations

| Threat | Initial control / acceptance |
|---|---|
| Cross-tenant data/action | Tenant ID enforced in DB/service/queue/storage; negative tests for every API/job path; never rely on hidden UI controls |
| Credential theft/log leakage | Vault references, TLS, least-privilege token, redaction, rotation/revoke path, secret scans; no token in fixtures, URLs or prompts |
| SSRF/DNS rebinding | Provider-specific allow-list, resolve and pin connection, reject private/link-local/metadata IPs, validate redirects and TLS; test DNS changes |
| Path traversal/command injection | Canonical path containment, argument arrays, no shell interpolation, untrusted filenames; adversarial tests |
| Forged/replayed agent/webhook request | Signed payload, nonce/timestamp, scoped keys, replay store and tenant binding |
| Unauthorized/destructive operation | Policy decision at API and worker immediately before call; dry run, idempotency, backups, approvals, audit and emergency stop |
| Backup corruption/exposure | Encryption, immutable/versioned storage when supported, checksums, retention, restore drill and scoped signed URLs |
| Malicious provider output / AI prompt injection | Treat response/content as data, schema validate, redact, do not execute embedded instructions; deterministic policy engine authorizes actions |
| Dependency or license risk | Lockfile, pinned runtime, dependency/SBOM and license scanning in CI |

## Implemented local prototype controls

- One-time bootstrap token file is created with mode `0600`; only its digest is stored in SQLite and it is consumed after the first owner is created.
- Passwords use salted `scrypt` hashes. Random session tokens are stored by hash, cookies are `HttpOnly`/`SameSite=Strict`, sessions expire after 12 hours, and logout/disabled-user checks revoke access.
- The local SQLite schema scopes accounts and jobs to an organization. API reads, site lookups, job lookups, audit reads and refresh requests include that scope. The worker rechecks the requesting actor's active state, organization and role.
- Cookie-authenticated writes enforce same-origin and the API limits failed login/bootstrap attempts per client IP in the current process.
- Owner/admin can query their own bootstrap and refresh audit records; the test verifies cross-tenant isolation and checks bootstrap credentials do not appear in events. This local log is not tamper-evident.
- Executed negative checks cover anonymous access, cross-tenant reads/actions, audit isolation, viewer-role restrictions, worker policy rechecks, session expiry/logout, cross-origin writes and login throttling. Evidence: `tests/inventory-api.test.mjs` and `docs/TEST_EVIDENCE/2026-11-09-local-poc.md`.

## Current blockers

The local proof now has an encrypted TOTP compatibility fallback and one-time recovery-code flow, but includes WebAuthn/passkey enrollment/login, inventory, revocation and password-reauthenticated rebinding, but browser flow remains unverified. Verified contact delivery, SSO, a vault, provider egress control, distributed rate limiting, production TLS/proxy guarantees and tamper-evident audit remain open. It is loopback-only and synthetic-data-only. Do not add real hosting secrets/data or expose it as a production service. Remaining security work is tracked in ORB-011 and ORB-010.

## MFA-specific local controls (mock-tested)

- Require an external 32-byte key to encrypt TOTP seeds with AES-256-GCM; never generate or persist this key automatically.
- TOTP uses a 30-second step, accepts at most the immediately previous step for delay, and stores the highest accepted step to reject replay. Failed login/enrollment/challenge attempts share the local per-IP throttle.
- Recovery codes use 128 bits of randomness, are hashed at rest and consumed once. MFA enrollment and recovery revoke pre-existing sessions; only newly issued factor-verified sessions remain valid when MFA is enabled. Disable requires password plus an unused TOTP, removes authenticators/codes, revokes all sessions and emits an audit record. Recovery creates an outbox record marked `blocked_unverified_contact`. This is not successful notification delivery.
- Tests cover an RFC 6238 vector, encryption/authentication, enrollment, login challenge, TOTP replay, recovery-code consumption and session revocation. WebAuthn server validation has unit/CI coverage; virtual-authenticator browser registration/assertion, counter update/replay and physical-device behavior are not verified.
