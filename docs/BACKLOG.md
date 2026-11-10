# Executable backlog

Canonical machine-readable tasks: [`backlog/tasks.json`](../backlog/tasks.json). Keep this summary synchronized. `status` is lifecycle; `verification_level` is evidence strength. A mock pass does not imply live-provider verification.

## Status vocabulary

Lifecycle: `proposed`, `researched`, `ready`, `in_progress`, `implemented_unverified`, `testing`, `verified`, `blocked`, `deferred`, `reopened`.

Evidence: `none`, `static`, `unit`, `mock_tested`, `browser_tested`, `integration_tested`, `live_verified`, `docs_reviewed`. Blocked tasks use `blocker_type`: `environment`, `external`, or `technical`, with exact blocker and next action.

## Current critical path

| ID | Task | Priority | Status | Evidence | Next exit |
|---|---|---:|---|---|---|
| ORB-001 | Phase 0 research and architecture | P0 | verified | docs_reviewed | Sources, permission matrix, unknowns and ADR recorded |
| ORB-002 | Mock inventory vertical slice | P0 | testing | mock_tested | API/SQLite/worker tests pass; browser/live gaps stay open |
| ORB-003 | AI rules, docs, diagrams and knowledge banks | P0 | verified | docs_reviewed | Populated and cross-linked; no empty compliance files |
| ORB-004 | PostgreSQL/Redis and durable worker | P1 | blocked | none | Try GitHub-hosted service containers; record result |
| ORB-005 | Local auth, tenant policy and audit | P1 | testing | mock_tested | Synthetic-data controls only; production gates remain |
| ORB-006 | Authorized live cPanel UAPI | P1 | blocked | none | Requires owner-authorized disposable account/token |
| ORB-007 | Local installer preflight/bootstrap | P1 | ready | none | Work independently of production services |
| ORB-008 | Bank validation/schema tooling | P0 | verified | docs_reviewed | Preserve reproducible validator evidence |
| ORB-009 | Browser UX/accessibility | P1 | blocked | none | Try hosted Chromium; earlier shared-browser failure is not universal |
| ORB-010 | Security/supply-chain umbrella | P1 | in_progress | none | Execute ORB-015 |
| ORB-011 | MFA/passkey and recovery gates | P1 | in_progress | unit | Server/UI and recovery management merged; browser/operational gates open |
| ORB-012–019 | Browser, notification, key recovery, scanning, services, installer, accessibility, live provider | P1 | mixed | none | Use exact task evidence contracts in machine backlog |

## Evidence-backed completion

- Phase 0 records ORB-001/003/008 as documentation/validation complete; this is not release readiness.
- ORB-002/005 have local mock evidence only.
- PR #2 shipped passkey server/UI; PR #3 shipped inventory/revocation/rebinding. CI history is indexed in [`docs/TEST_EVIDENCE/2026-11-10-github-ci.md`](TEST_EVIDENCE/2026-11-10-github-ci.md).
- Current CI checks install, tests, lint, build, smoke and doctor. Browser E2E, threat-model scans, SBOM/license, DB/queue service tests and live provider verification remain absent.

## Blocker interpretation

- ORB-004 is an environment-blocked proof; authoring Compose/CI work can proceed.
- ORB-006/019 require an authorized disposable provider account.
- ORB-009's previous shared-browser failure does not establish hosted-runner failure.
- ORB-007 covers local preflight; ORB-017 gates production services and upgrade/recovery.
- New work must record exact commit and workflow evidence. Historical task commit mappings remain null where the audit cannot attribute a precise commit.
