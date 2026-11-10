# Project state

**Updated:** 2026-11-10 04:25 Asia/Karachi
**Product:** VSN ORBICORE — AI-assisted hosting control plane
**Phase:** Phase 0 exit met; Phase 1 in progress. ORB-001/003/008 verified; ORB-002/005 mock-tested; ORB-011 WebAuthn server/UI implementation in progress; server CI passed on current checkpoint.
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

- Phase 0 was merged to `main` at `4edee8239329293c5c8a34a90eb72be348d7e0ea`; work for ORB-011 is isolated on `feat/orb-011-webauthn`.
- Added the maintained `@simplewebauthn/server` 14.1.0 dependency and lockfile. GitHub Actions resolved the lockfile on the feature branch.
- ORB-011 server and UI now add passkey enrollment/login flows and one-time, five-minute enrollment and login challenges; password-reauthenticated passkey enrollment; required user verification; configured RP ID/origin validation; signature verification; credential counters with conditional updates; counter-replay rejection; challenge replay rejection; and passkey audit events.
- Added tests for origin mismatch, expired registration challenges, consumed-challenge replay, and unavailable credentials. GitHub Actions passed npm ci, tests, lint, build, smoke, and doctor on the server checkpoint; passkey UI changes are now awaiting CI.
- Existing limits remain: notification contact is unverified, no notification delivery, no key backup/rotation runbook, no browser UI verification, no PostgreSQL/Redis, no live provider connections, and no production readiness. Keep credentials out of the prototype.
