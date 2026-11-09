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

The local API binds to loopback and uses the synthetic fixture. MFA, recovery codes, SSO, account lock/recovery UX, a secret vault, distributed throttling, PostgreSQL sessions, key rotation, production TLS/proxy trust, and browser verification are not implemented. Do not expose this prototype or enter real hosting credentials.

## MFA and recovery design for the next auth increment

- Require MFA before owners/admins can store provider credentials or perform high-impact operations. Prefer WebAuthn/passkeys as the phishing-resistant option; if TOTP is offered for compatibility, label it as a fallback and do not describe it as phishing-resistant.
- Issue high-entropy, one-time recovery codes at MFA enrollment. Store only code hashes, display the set once, support revocation/regeneration only after strong reauthentication, notify all verified account contacts on use, invalidate other sessions and require authenticator rebinding when MFA recovery is used.
- Provide a documented offline self-hosted recovery procedure that requires explicit instance-owner access and emits an audit record; do not use email-only reset as a bypass around MFA.
- Treat these as target design only. The local build does not implement MFA or account recovery and makes no NIST assurance-level claim. Review final flows against current NIST SP 800-63B before implementation.

The design follows the NIST guidance that AAL2 applications offer a phishing-resistant authentication option and that account recovery should notify subscribers; manually entered OTP is not phishing-resistant. See the current [NIST SP 800-63B (4th Revision)](https://pages.nist.gov/800-63-4/sp800-63b.html) and sections 3.2.5 and 4.2.1.2/4.2.1.3.
