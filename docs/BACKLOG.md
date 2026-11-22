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
| ORB-004 | PostgreSQL outbox and Redis synthetic worker | P1 | testing | integration_tested | [Atomic PG job/outbox + standalone synthetic Redis worker CI passed](TEST_EVIDENCE/2026-11-22-orb-004-outbox-worker.md) with SIGKILL/reclaim; complete PostgreSQL identity migration, runtime authorization and production policy remain open |
| ORB-005 | Tenant-scoped PostgreSQL identity, authenticated CI login and atomic audit | P1 | in_progress | integration_tested | [Atomic PostgreSQL auth audit proof](TEST_EVIDENCE/2026-11-22-orb-005-pg-atomic-auth-audit.md): 75 tests, nine service jobs, redacted SHA-256 login/MFA/logout events, strict grants and forced rollback; production SQLite scrypt credential migration, real MFA, full failure audit, secrets, TLS and cutover remain open |
| ORB-006 | Authorized live cPanel UAPI | P1 | blocked | none | Requires owner-authorized disposable account/token |
| ORB-007 | Local installer preflight/bootstrap | P1 | testing | mock_tested | Preflight & SQLite backup/verify pass locally; prod upgrade tracked in ORB-017 |
| ORB-008 | Bank validation/schema tooling | P0 | verified | docs_reviewed | Preserve reproducible validator evidence |
| ORB-009 | Browser UX/accessibility | P1 | ready | none | Hosted Chromium available; complete keyboard, contrast, and responsive/error/permission review |
| ORB-010 | Security/supply-chain umbrella | P1 | in_progress | none | ORB-015 CI audit/SBOM passed; full production security validation remains |
| ORB-011 | MFA/passkey and recovery gates | P1 | in_progress | unit | Browser E2E passed; multi-hyphen recovery code regression fixed; physical/live notifications remain |
| ORB-013 | Verified recovery contacts & outbox | P1 | testing | mock_tested | Simulated outbox & retry tracking tested; live SMTP provider gated |
| ORB-014 | MFA key rotation & backup verify | P1 | testing | unit | Versioned keyring rotation & backup integrity tested locally |
| ORB-015 | Threat-model tests & CI gates | P1 | verified | unit | [CI audit, 45 tests, SBOM artifact](TEST_EVIDENCE/2026-11-22-orb-015-audit-sbom-ci.md); release/compliance review still separate |
| ORB-012 | Virtual-authenticator browser E2E | P1 | verified | browser_tested | [Chromium run 44995181964](TEST_EVIDENCE/2026-11-22-orb-012-browser-e2e.md); physical authenticator remains separate |
| ORB-016 | Hosted PostgreSQL/Redis services | P1 | testing | integration_tested | [Service parity](TEST_EVIDENCE/2026-11-22-orb-016-services-ci.md) and [synthetic outbox/worker integration](TEST_EVIDENCE/2026-11-22-orb-004-outbox-worker.md) passed; full PG identity, off-host backup, real host crash and HA failover remain open |
| ORB-017–019 | Installer, accessibility and live provider | P1 | mixed | none / mock | Use exact task evidence contracts in machine backlog |

## Evidence-backed completion

- Phase 0 records ORB-001/003/008 as documentation/validation complete; this is not release readiness.
- ORB-002/005 have local mock evidence only.
- PR #2 shipped passkey server/UI; PR #3 shipped inventory/revocation/rebinding. CI history is indexed in [`docs/TEST_EVIDENCE/2026-11-10-github-ci.md`](TEST_EVIDENCE/2026-11-10-github-ci.md).
- Current CI checks install, tests, lint, build, smoke and doctor. Virtual-authenticator browser E2E passed in [ORB-012](TEST_EVIDENCE/2026-11-22-orb-012-browser-e2e.md). Physical authenticator, complete accessibility, full production identity/tenant DB migration, off-host/host-failure recovery and live provider verification remain open. Hosted service schema/Redis checks passed in [ORB-016](TEST_EVIDENCE/2026-11-22-orb-016-services-ci.md). ORB-015 now verifies the PR's npm audit, scoped secret/license scans and uploaded lockfile SBOM; full release compliance/schema validation are separate.

## Blocker interpretation

- ORB-004 now includes a hosted, explicitly opted-in **synthetic** PostgreSQL job/outbox and Redis Streams worker with real child-process SIGKILL/lease recovery evidence. SQLite identity/account/audit remain a hybrid test fixture; complete PostgreSQL migration, trusted runtime write-role isolation, host-crash/off-host durability and live provider verification remain open. Disposable Compose named-volume and Redis AOF recreation have passed [ORB-016](TEST_EVIDENCE/2026-11-22-orb-016-compose-recreation.md).
- ORB-006/019 require an authorized disposable provider account.
- ORB-009 is now ready: hosted Chromium works; full browser accessibility/visual review remains to be implemented.
- ORB-007 covers local preflight; ORB-017 gates production services and upgrade/recovery.
- New work must record exact commit and workflow evidence. Historical task commit mappings remain null where the audit cannot attribute a precise commit.
