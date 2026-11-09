# Project state

**Updated:** 2026-11-09 23:41 Asia/Karachi
**Product:** VSN ORBICORE — AI-assisted hosting control plane
**Phase:** Phase 0 exit met; Phase 1 in progress. ORB-001/003/008 verified; ORB-002/005 mock-tested; ORB-011 MFA compatibility fallback in progress.
**Branch at task start:** `feat/phase-0-foundation`, based on upstream `main` commit `eb2a67ed18f9848ec12484e5d0d7a9f9367ef481`
**Initial repository baseline:** at Phase 0 start, only README and master directive existed; current source/doc tree is now present
**Verified environment:** Node.js 24.22.1, npm 11.9.0, Python 3.12; npm registry reachable; Docker/PostgreSQL/Redis absent

## Verified facts

- Public GitHub repository: `Vertex-Systems-Network/vsn-orbicore`; default branch `main`; branch was not protected when inspected.
- The full master directive is present at the root. Its 22 sections govern the product and delivery.
- The directive requires read-only cPanel inventory proof-of-concept, a local API/demo, durable project state, and capability/permission-aware operations.
- cPanel UAPI supports account-context operations. WHM Transfer Tool documentation describes source-server root or `sudo`/`su` access. Remote database exposure is configurable by the host/provider.
- No real cPanel/WHM test account or sandbox was supplied. Provider behavior is unknown and not live-verified.

## Status labels

Use `DESIGNED`, `IMPLEMENTED`, `MOCK-TESTED`, `INTEGRATION-TESTED`, `LIVE-VERIFIED`, `RELEASED`; distinguish `blocked_external` from technical blockers. Planned behavior is not implemented behavior.

## Current checkpoint

- Last pushed feature branch: `f7fb336da48bd2b8a035270e7aa588730981d82a` on `feat/phase-0-foundation`; local code and documentation are verified in the current worktree; checkpoint commit/push follows.
- Local code: fixture-backed account/site API, SQLite persistence, refresh worker, React dashboard and tests. Local checks are recorded in `docs/TEST_EVIDENCE/2026-11-09-local-poc.md`.
- Feature branch was published to GitHub in the prior checkpoint; the GitHub connector commit differs from local Git commit metadata but represents the same tracked file tree.
- Phase 0 exit criteria are met: research/specification/banks are internally cross-validated and Phase 0 tests pass; the current suite adds auth and smoke coverage. ORB-001/003/008 are verified; ORB-002 remains mock-tested. Browser QA ORB-009 is a Phase 1 blocker. ORB-005 local auth/tenant/audit slice is mock-tested. ORB-011 TOTP compatibility and recovery-code behavior is mock-tested; WebAuthn/passkeys, verified notification delivery, authenticator rebinding and production identity gates remain open before any real credentials.
