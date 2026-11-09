# ADR-0002: Local bootstrap, opaque sessions, and organization scoping

**Status:** implemented for the local prototype; production identity is not approved.
**Date:** 2026-11-09
**Decision owner:** project maintainers

## Decision

- On first startup with no users, create a cryptographically random one-time bootstrap token in `.data/first-admin.token` with filesystem mode `0600`. Store only its SHA-256 digest in SQLite; consume it on successful owner creation and remove the token file. If the token file is lost before setup, a new token is generated on next startup while the account table remains empty.
- Hash passwords with Node's `scryptSync`, a fresh 16-byte salt per user, and a 64-byte output. Never return a password hash or bootstrap digest through the API.
- Generate 256-bit random opaque session tokens. Store only SHA-256 hashes, expire sessions after 12 hours, and revoke server-side at logout or when the user is disabled. Cookies are `HttpOnly`, `SameSite=Strict`, path-wide, and optionally `Secure` when `ORBICORE_COOKIE_SECURE=1` is configured behind HTTPS.
- Check the exact request `Origin` against the Host on cookie-authenticated mutation routes. The session cookie's `SameSite=Strict` policy is an additional CSRF control.
- Scope account, website, and job queries by organization. Persist the requesting actor and organization on refresh jobs. The worker checks that the actor is still enabled, belongs to the job organization, and retains an owner/admin/operator role before processing.
- Write bootstrap and refresh success/failure audit events with actor, organization, target, and redacted outcome details. Owner/admin can query rows only within their organization. The prototype exposes no audit mutation route, but SQLite rows are not tamper-evident.
- Use a per-process limit of 10 failed login/bootstrap attempts per client IP per 10-minute window. This is a local prototype control, not a distributed defense.

## Verification and limits

Local tests cover one-time bootstrap, anonymous denial, cross-tenant reads and refresh attempts, password/bootstrap secret storage, session expiry/logout, viewer denial, worker policy recheck, same-origin rejection, and failed-login throttling. See `docs/TEST_EVIDENCE/2026-11-09-local-poc.md`.

The local API binds to loopback and uses the synthetic fixture. WebAuthn/passkeys, verified notification contacts and delivery, authenticator recovery/rebinding, SSO, a secret vault, distributed throttling, PostgreSQL sessions, key rotation, production TLS/proxy trust, and browser verification are not implemented. A local TOTP compatibility fallback, one-time recovery-code hashes, and a blocked notification-outbox record are implemented and mock-tested only. Do not expose this prototype or enter real hosting credentials.

## MFA implementation status and remaining design gates

- Owners/admins can enroll a TOTP compatibility fallback, verify a six-digit code, and receive ten one-time recovery codes. The UI labels TOTP as not phishing-resistant. Login requires a second factor for accounts with MFA enabled. Enrollment requires current-password reauthentication, revokes existing password-only sessions and creates a factor-verified session; MFA-disabled sessions are rejected once the user enables MFA.
- TOTP seed material is encrypted with AES-256-GCM using a separately configured 32-byte key (`ORBICORE_MFA_ENCRYPTION_KEY`). The process refuses enrollment/login challenge when the key is absent or invalid. Recovery codes are random 128-bit values; only SHA-256 hashes are stored, codes are shown once, and replay is rejected.
- Recovery-code login consumes the code, revokes existing sessions, writes an audit record and creates a new factor-verified session plus a notification-outbox entry. MFA disable requires both current password and an unused current TOTP code; it clears authenticators/recovery codes, revokes all sessions, audits, and signs the actor out. Delivery is blocked while the email/contact is unverified and no notification provider is configured; the app does not claim the notification was sent.
- WebAuthn/passkey enrollment and login, authenticator rebinding, recovery-code replacement, verified contact management/delivery, production key storage/rotation, and distributed throttling are still open. Provider credentials remain out of scope and must not be entered.
- The NIST recovery and notification guidance and RFC 6238 TOTP replay guidance informed the design, but no NIST assurance-level claim is made. Review the current standards before production use.

The design follows the NIST guidance that AAL2 applications offer a phishing-resistant authentication option and that account recovery should notify subscribers; manually entered OTP is not phishing-resistant. See the current [NIST SP 800-63B (4th Revision)](https://pages.nist.gov/800-63-4/sp800-63b.html) and sections 3.2.5 and 4.2.1.2/4.2.1.3.
