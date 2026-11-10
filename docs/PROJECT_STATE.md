# Project state

**Updated:** 2026-11-10
**Product:** VSN ORBICORE — AI-assisted hosting control plane
**Canonical repository:** [Vertex-Systems-Network/vsn-orbicore](https://github.com/Vertex-Systems-Network/vsn-orbicore)
**Audit baseline:** `main` at `fac13611c21cfbeec6148a7cbd93a0799dfc4c45`
**Phase:** Phase 0 exit documented; Phase 1 in progress. ORB-001/003/008 are documentation/validation complete; ORB-002/005 mock-tested only. ORB-011 passkey implementation and recovery controls are merged; browser and operational gates remain.
**Workflow:** GitHub-only: feature branch → PR → Actions → review → merge. No local clone/checkpoint.

## Verified facts

- Phase 0 merged at `4edee8239329293c5c8a34a90eb72be348d7e0ea`.
- Passkey server/UI merged in PR #2 at `bdd3b6179d911cb0abdd3a35f9aefb17dca02ab5`; inventory/revocation/rebinding merged in PR #3 at `c4cdab76a82578fc4db698b04098e0234e5570a2`; PR #4 synchronized documentation at the audit baseline.
- Actions: PR #2 [run 42733887820](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/42733887820) passed 20 tests, lint, build, smoke and doctor; PR #3 [run 42734476163](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/42734476163) passed 21 tests and same checks; PR #4 [run 42734679968](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/42734679968) passed documentation CI. Details: `docs/TEST_EVIDENCE/2026-11-10-github-ci.md`.
- Server-side WebAuthn checks RP/origin, user verification, one-time expiring challenges and conditional credential counters. Unit CI is not browser/device proof.
- No authorized provider sandbox exists; no live provider verification, production PostgreSQL/Redis or production readiness is claimed.
- Earlier local environment lacked Docker/PostgreSQL/Redis; GitHub-hosted service container feasibility is not yet known.

## Status model

Task `status` is lifecycle; `verification_level` is evidence strength. Blocked tasks require `blocker_type` (`environment`, `external`, `technical`) and precise blocker/next action. See master prompt Section 10 and `docs/BACKLOG.md`.

## Open gates

ORB-012 browser passkey E2E; ORB-015 security/supply-chain checks; ORB-016 PostgreSQL/Redis integration; ORB-007 local installer; ORB-017 production install/upgrade/recovery; ORB-013 verified notifications; ORB-014 key rotation/restore; ORB-018 accessibility; ORB-006/019 authorized live cPanel test.

Prototype remains loopback/synthetic-only; do not accept real provider credentials or expose it.
