# Next action

1. Add a browser end-to-end test with a Chromium virtual authenticator for passkey enrollment, assertion, counter update, and replay rejection.
2. Run the same flow with a physical platform authenticator/security key on the configured HTTPS hostname before treating passkeys as browser-verified.
3. Implement and test consistent database backup/restore and TOTP encryption-key rotation tooling. Follow `docs/AUTHENTICATOR_OPERATIONS.md`; changing the key alone loses access to existing encrypted TOTP seeds.
4. Add verified notification-contact setup/delivery when a delivery integration is available. Keep recovery notices marked blocked until delivery is verified.
5. Complete ORB-010 threat-model tests and reproducible dependency/SBOM/license scans before provider credentials or prototype exposure.
6. Keep ORB-004 blocked until PostgreSQL/Redis are available and ORB-006 blocked until an owner-authorized disposable cPanel account/token is available.

**Current verified result:** Phase 0 and ORB-011 server/UI/passkey recovery controls are merged to `main`. PR #2 and PR #3 passed GitHub CI (21 tests on the latest checkpoint, lint, build, smoke, doctor). Browser authenticator assertions and physical-device verification, database restore/key rotation, verified notification delivery, live providers, PostgreSQL/Redis, and production readiness remain unverified.
