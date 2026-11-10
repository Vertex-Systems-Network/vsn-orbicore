# Next action

1. Run branch CI for passkey inventory/revocation and lost-device rebinding, then fix all failures.
2. Verify a full enrollment/assertion/counter-update flow with a browser virtual authenticator and later a physical authenticator on the configured HTTPS origin and RP ID.
3. Implement and test consistent database backup/restore and TOTP encryption-key rotation tooling. Follow the limits in `docs/AUTHENTICATOR_OPERATIONS.md`; changing the key alone loses access to existing encrypted TOTP seeds.
4. Add verified notification-contact setup/delivery when a delivery integration is available. Keep recovery notices marked blocked until actual delivery is verified.
5. Complete ORB-010 threat-model tests and reproducible dependency/SBOM/license scans before provider credentials or prototype exposure.
6. Keep ORB-004 blocked until PostgreSQL/Redis are available and ORB-006 blocked until an owner-authorized disposable cPanel account/token is available.

**Current verified result:** Phase 0 and the ORB-011 passkey server/UI checkpoint are merged to `main`. PR #2 passed CI (20 tests, lint, build, smoke, doctor). Passkey list/revoke/rebind work is in progress on `feat/orb-011-passkey-recovery`; virtual/physical authenticator assertions, notification delivery, database restore/key rotation, live providers, PostgreSQL/Redis, and production readiness remain unverified.
