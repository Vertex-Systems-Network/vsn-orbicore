# Next action

1. Continue ORB-011: implement WebAuthn/passkey enrollment and login assertions using a maintained library; test challenge expiry, origin/RP ID binding, credential counters and replay.
2. Complete safe authenticator recovery/rebinding, verified notification-contact setup and delivery, and key backup/rotation runbook; do not treat the current blocked outbox row as a sent notification.
3. Do not accept provider credentials or expose the prototype until ORB-011 security gates and deployment controls pass.
4. Then work ORB-010 threat-model tests and reproducible dependency/SBOM/license scans.
5. Add browser-level verification when the browser can reach the local runtime. Keep ORB-004 blocked until PostgreSQL/Redis are available and ORB-006 blocked until an owner-authorized disposable cPanel account/token is available.

**Current verified result:** Phase 0 exit criteria met. ORB-001/003/008 are verified; ORB-002/005 and the TOTP/recovery local slice are mock-tested only. Current tests cover bootstrap/login, tenant-scoped reads/jobs/audit, worker policy rechecks, TOTP RFC vector and replay, encrypted seed, recovery-code hashing/use, MFA enrollment session reset, recovery session revocation, password-plus-TOTP disable/revocation, MFA challenge expiry/lockout, and the blocked notification outbox. WebAuthn, delivered notifications, rendered browser UI, live providers, PostgreSQL/Redis, and production readiness remain unverified.
