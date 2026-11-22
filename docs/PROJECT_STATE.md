# Project state

**Updated:** 2026-11-21
**Product:** VSN ORBICORE — AI-assisted hosting control plane
**Canonical repository:** [Vertex-Systems-Network/vsn-orbicore](https://github.com/Vertex-Systems-Network/vsn-orbicore)
**Audit baseline:** `main` at `fac13611c21cfbeec6148a7cbd93a0799dfc4c45`
**Phase:** Phases 0–8 local/mock vertical slices implemented; external live-provider, Docker/PostgreSQL runtime, and hosted browser verification gates remain open.

## Verified facts

- Phase 0 merged at `4edee8239329293c5c8a34a90eb72be348d7e0ea`.
- Passkey server/UI merged in PR #2 at `bdd3b6179d911cb0abdd3a35f9aefb17dca02ab5`; inventory/revocation/rebinding merged in PR #3 at `c4cdab76a82578fc4db698b04098e0234e5570a2`; PR #4 synchronized documentation at the audit baseline.
- Actions: PR #2 [run 42733887820](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/42733887820) passed 20 tests, lint, build, smoke and doctor; PR #3 [run 42734476163](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/42734476163) passed 21 tests and same checks; PR #4 [run 42734679968](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/42734679968) passed documentation CI. Details: `docs/TEST_EVIDENCE/2026-11-10-github-ci.md`.
- Local workspace vertical slices pass **42 automated tests**, `npm run security:check` (static secret scan, OSS license check, CycloneDX SBOM summary), `npm run lint`, `npm run build`, `npm run smoke`, and `npm run doctor`. Covered capabilities: SSRF/traversal/redaction & injection boundary security (`security.mjs`), SHA-256 tamper-evident audit hash chain & `/api/audit/verify` (`audit.mjs`), preflight/deployment-readiness wizard (`GET /api/system/deployment-readiness`), encrypted secret references (`v7` `secret_references`), backup/fail-closed restore drills & v1-v7 SQLite upgrade + job crash recovery (`preflight.mjs`, `server.mjs`), team RBAC, cPanel UAPI mock + read-only client boundary (`cpanel-adapter.mjs`), pre-seeded demo workflows + extended `/api/system/demo-seed`, migration state machine + 30% checkpoint failure/resume, storage fail-closed/rehydration drills, WordPress staging/update/rollback lifecycle, deterministic advisory insights, policy-gated dry-run automation (`automation.mjs`), Light/Dark theme toggle & sortable inventory tables, and agency readiness report export.
- Database schema parity (`v7`) and browser CI workflows exist (`docker-compose.yml`, `db/postgres-schema.sql`, `.github/workflows/ci-services.yml`, `.github/workflows/ci-browser.yml`, `scripts/browser-verify.mjs`), remaining untested against live Docker/PostgreSQL or hosted Chromium runners in this container.
- No authorized provider sandbox exists (`liveConnections: 0`); no live provider verification, production PostgreSQL/Redis, physical passkey E2E, or production readiness is claimed.

## Status model

Task `status` is lifecycle; `verification_level` is evidence strength. Blocked tasks require `blocker_type` (`environment`, `external`, `technical`) and precise blocker/next action. See master prompt Section 10 and `docs/BACKLOG.md`.

## Open gates

ORB-012 browser passkey E2E; ORB-015 GitHub Actions security run; ORB-016 PostgreSQL/Redis container integration; ORB-017 production install/upgrade/recovery; ORB-018 browser accessibility review; ORB-006/019 authorized live cPanel test; live email/notification provider delivery.

Prototype remains synthetic-only (`liveConnections: 0`); do not store real provider credentials.
