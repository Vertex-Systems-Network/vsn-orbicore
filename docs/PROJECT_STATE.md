# Project state

**Updated:** 2026-11-10 05:10 Asia/Karachi
**Product:** VSN ORBICORE — AI-assisted hosting control plane
**Phase:** Phase 0 exit met; Phase 1 in progress. ORB-001/003/008 verified; ORB-002/005 mock-tested; ORB-011 WebAuthn server/UI merged and CI-verified; authenticator recovery management in progress.
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

- Phase 0 was merged to `main` at `4edee8239329293c5c8a34a90eb72be348d7e0ea`. ORB-011 WebAuthn passkey server and UI checkpoint was merged via PR #2 at `bdd3b6179d911cb0abdd3a35f9aefb17dca02ab5`.
- GitHub CI passed on that merge: npm ci, 20 tests, lint, build, smoke, and doctor. The passkey routes use SimpleWebAuthn; challenges expire after five minutes and are consumed once; the server requires user verification and validates expected RP ID/origin. Credential counters are checked and updated conditionally.
- Current branch `feat/orb-011-passkey-recovery` adds owner passkey inventory/revocation, password reauthentication and recovery UI, with a dedicated operations guide. This branch has not yet been CI-verified.
- Browser-level registration/assertion with a virtual or physical authenticator remains unverified. Verified notification contact/delivery is blocked because no delivery integration is configured. Key rotation and automated restore are blocked until migration/restore tooling exists; see `docs/AUTHENTICATOR_OPERATIONS.md`.
- Existing limits remain: no live provider connections, no PostgreSQL/Redis, no production readiness. Do not accept provider credentials or expose the prototype.
