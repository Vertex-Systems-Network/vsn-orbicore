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

- Latest tested software checkpoint: local commit `752d23b9ec68bb1f73e56df88d58afa4c3357e2e`; published GitHub equivalent `00068c85f795a5370b891b4c36480ddc69678aed` on `feat/phase-0-foundation`. The connector recreated commit metadata while preserving the tracked tree.
- Local code: fixture-backed account/site API, SQLite persistence, refresh worker, React dashboard, auth/MFA fallback and tests. `npm test` passed 18/18; lint, build, doctor, Vite-proxied smoke and `git diff --check` passed. Evidence and limits are in `docs/TEST_EVIDENCE/2026-11-09-local-poc.md` and `docs/TEST_EVIDENCE/2026-11-09-mfa-local.md`.
- Feature branch is current through the MFA checkpoint. Local/remote commit SHAs differ due to connector-created Git metadata; remote compare against `main` should show the feature branch ahead and not behind.
- Phase 0 exit criteria are met: research/specification/banks are internally cross-validated and Phase 0 tests pass; the current suite adds auth and smoke coverage. ORB-001/003/008 are verified; ORB-002 remains mock-tested. Browser QA ORB-009 is a Phase 1 blocker. ORB-005 local auth/tenant/audit slice is mock-tested. ORB-011 TOTP compatibility and recovery-code behavior is mock-tested; WebAuthn/passkeys, verified notification delivery, authenticator rebinding and production identity gates remain open before any real credentials.
