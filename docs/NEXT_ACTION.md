# Next action

1. **ORB-016 / ORB-004:** Execute `.github/workflows/ci-services.yml` on a GitHub-hosted runner with PostgreSQL 16 and Redis 7 services. Test PostgreSQL schema apply/re-apply, migrations, Redis ping and data round-trip, service restart/recovery where possible, and preserve exact CI URLs and versions. The currently defined workflow is schema/connection parity only; do not call it integrated production DB/queue recovery.
2. Implement the missing production DB adapter and durable queue/worker recovery in an isolated, tested slice before claiming Phase 1 infrastructure complete. Keep existing SQLite synthetic mode and tests intact.
3. **ORB-018 / ORB-009:** Extend hosted Chromium accessibility checks to focus order, keyboard, contrast, mobile/desktop layouts, loading, stale, error, permissions and empty states. ORB-012 basic DOM smoke does not close accessibility.
4. **ORB-010:** Full security validation, upstream CycloneDX JSON schema validation, actual release BOM/build assets, secret scanning coverage, and production vault/identity review remain separate from completed ORB-015 CI gates.
5. **ORB-011 / ORB-013 / ORB-014 / ORB-017:** Manual/physical authenticator and live verified-contact delivery, production key management, restore, installer and upgrade safeguards are still open.
6. **ORB-006 / ORB-019:** Owner-authorized disposable cPanel account/token required before any read-only live test; do not perform live provider operations with current mock fixtures.

## Verified checkpoints

- **ORB-012:** Chromium CTAP2 virtual-authenticator E2E verified, PR [#7](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/7) merged in `main` as `1f8dec9446089dd38a4eb723e278467d7106484d`. [Run 44995181964](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44995181964), detailed [evidence](TEST_EVIDENCE/2026-11-22-orb-012-browser-e2e.md).
- **ORB-015:** PR [#8](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/8) implementation SHA `5e0cf94130e36c803a94c61b8d9f8a1828d13670` passed [GitHub CI 44995631637](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44995631637) (44 tests, npm audit zero findings, lockfile BOM with 169 components and an uploaded artifact). See [evidence](TEST_EVIDENCE/2026-11-22-orb-015-audit-sbom-ci.md); confirm final PR head checks and merged main SHA separately.
- ORB-012/015 evidence does not imply physical authenticator, complete accessibility, external SBOM schema validation, production distributed databases/jobs or live hosting verification.

## Evidence contract

Record task ID, GitHub Actions run URL, tested SHA, jobs/commands, runtime, outcome, artifacts, and limitations in `docs/TEST_EVIDENCE/`. Never claim a passed external gate based on mock/local evidence alone.
