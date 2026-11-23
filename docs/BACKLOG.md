# Executable backlog

Canonical machine-readable tasks: [`backlog/tasks.json`](../backlog/tasks.json). Keep this summary synchronized. `status` is lifecycle; `verification_level` is evidence strength. A mock pass does not imply live-provider verification.

## Status vocabulary

**Automatic PR task table:** All new/reopened/edited/pushed PRs receive the complete canonical task table through a trusted-base GitHub Action. PR head backlog status overrides main baseline; all open PR tables refresh when main backlog changes. Source updates must include honest dates, evidence and blockers; no bot can auto-verify a task. See [PR governance](AUDIT/2026-11-23-ai-plan-pr-governance.md).


Lifecycle: `proposed`, `researched`, `ready`, `in_progress`, `implemented_unverified`, `testing`, `verified`, `blocked`, `deferred`, `reopened`.

Evidence: `none`, `static`, `unit`, `mock_tested`, `browser_tested`, `integration_tested`, `live_verified`, `docs_reviewed`. Blocked tasks use `blocker_type`: `environment`, `external`, or `technical`, with exact blocker and next action.

## Current critical path

| ID | Task | Priority | Status | Evidence | Next exit |
|---|---|---:|---|---|---|
| ORB-001 | Phase 0 research and architecture | P0 | verified | docs_reviewed | Sources, permission matrix, unknowns and ADR recorded |
| ORB-002 | Mock inventory vertical slice | P0 | testing | mock_tested | API/SQLite/worker tests pass; browser/live gaps stay open |
| ORB-003 | AI rules, docs, diagrams and knowledge banks | P0 | verified | docs_reviewed | Populated and cross-linked; no empty compliance files |
| ORB-004 | PostgreSQL outbox and Redis synthetic worker | P1 | testing | integration_tested | [23-job HMAC-signed and PG-anchored Redis event proof](TEST_EVIDENCE/2026-11-23-orb-004-signed-wakeup.md) plus [22-job restricted full synthetic worker](TEST_EVIDENCE/2026-11-23-orb-004-full-worker-gateway.md) plus [21-job nonowner tenant-bound PG signal gateway](TEST_EVIDENCE/2026-11-23-orb-004-scoped-signal-writer.md) plus [20-job redacted poison-signal before-ACK integration](TEST_EVIDENCE/2026-11-23-orb-004-poison-signal-quarantine.md) plus [Atomic PG job/outbox + standalone synthetic Redis worker CI passed](TEST_EVIDENCE/2026-11-22-orb-004-outbox-worker.md) with SIGKILL/reclaim; complete PostgreSQL identity migration, runtime authorization and production policy remain open |
| ORB-005 | Tenant-scoped PostgreSQL identity, authenticated CI login and atomic audit | P1 | in_progress | integration_tested | [Atomic PostgreSQL auth audit proof](TEST_EVIDENCE/2026-11-22-orb-005-pg-atomic-auth-audit.md): 75 tests, nine service jobs, redacted SHA-256 login/MFA/logout events, strict grants and forced rollback; production SQLite scrypt credential migration, real MFA, full failure audit, secrets, TLS and cutover remain open; [HTTP JSON ingress byte/UTF-8/object regression](TEST_EVIDENCE/2026-11-23-orb-005-http-json-ingress.md) awaiting hosted CI |
| ORB-006 | Authorized live cPanel UAPI | P1 | blocked | none | Requires owner-authorized disposable account/token |
| ORB-007 | Local installer preflight/bootstrap | P1 | testing | mock_tested | Preflight & SQLite backup/verify pass locally; prod upgrade tracked in ORB-017 |
| ORB-008 | Bank validation/schema tooling | P0 | verified | docs_reviewed | Preserve reproducible validator evidence |
| ORB-009 | Browser UX/accessibility | P1 | testing | browser_tested | [60 sampled Chromium 200% font-only override checks and four real CSS overflow fixes](TEST_EVIDENCE/2026-11-23-orb-009-018-200percent-text-only-simulated-browser.md); native Firefox Text Only Zoom, WebKit, full manual WCAG and production auth/provider checks pending |
| ORB-010 | Security/supply-chain umbrella | P1 | in_progress | unit | [113 passing CI tests, unknown license/missing lockfile fail-closed gate](TEST_EVIDENCE/2026-11-23-orb-010-unknown-license-lockfile-denial.md) and 254 Git-tracked recognized text file scan at PR #50 functional CI; deployed-system attestation, historical secrets and production security review remain |
| ORB-011 | MFA/passkey and recovery gates | P1 | in_progress | unit | Browser E2E passed; multi-hyphen recovery code regression fixed; physical/live notifications remain |
| ORB-013 | Verified recovery contacts & outbox | P1 | testing | mock_tested | Simulated outbox & retry tracking tested; live SMTP provider gated |
| ORB-014 | MFA key rotation & backup verify | P1 | testing | mock_tested | Versioned keyring rotation & backup integrity tested locally |
| ORB-015 | Threat-model tests & CI gates | P1 | verified | unit | [CI audit, 45 tests, SBOM artifact](TEST_EVIDENCE/2026-11-22-orb-015-audit-sbom-ci.md); release/compliance review still separate |
| ORB-012 | Virtual-authenticator browser E2E | P1 | verified | browser_tested | [Chromium run 44995181964](TEST_EVIDENCE/2026-11-22-orb-012-browser-e2e.md); physical authenticator remains separate |
| ORB-016 | Hosted PostgreSQL/Redis services | P1 | testing | integration_tested | [19-job isolated PG16 cluster / encrypted archive and grants proof](TEST_EVIDENCE/2026-11-23-orb-016-isolated-encrypted-restore.md); [18-job hosted PG16 clean-database restore proof](TEST_EVIDENCE/2026-11-23-orb-016-017-pg16-restore.md); [Service parity](TEST_EVIDENCE/2026-11-22-orb-016-services-ci.md) and [synthetic outbox/worker integration](TEST_EVIDENCE/2026-11-22-orb-004-outbox-worker.md) passed; full PG identity, off-host backup, real host crash and HA failover remain open |
| ORB-017 | Production install and upgrade | P1 | testing | integration_tested | [Fail-closed deployment-readiness tests](TEST_EVIDENCE/2026-11-23-orb-009-017-018-hardening.md); [isolated PG16 encrypted CI restore](TEST_EVIDENCE/2026-11-23-orb-016-isolated-encrypted-restore.md) now tests role/RLS/grant parity on a separate cluster on SAME runner; independent offsite/upgrade/KMS still blocked |
| ORB-018 | Browser dashboard accessibility | P1 | testing | browser_tested | [60 sampled Chromium 200% font-only override checks and four real CSS overflow fixes](TEST_EVIDENCE/2026-11-23-orb-009-018-200percent-text-only-simulated-browser.md); native Firefox Text Only Zoom, WebKit, full manual WCAG and production auth/provider checks pending |
| ORB-019 | Live cPanel sandbox | P1 | blocked | none | Requires owner-scoped disposable provider token |
| ORB-020 | AI plan and PR task ledger governance | P1 | verified | integration_tested | [PR #52 opened/synchronize/edited and PR #53 open-PR backfill real GitHub evidence](TEST_EVIDENCE/2026-11-23-orb-020-live-pr-ledger-webhook.md): 20 current task rows, original PR text preserved, stale PR head cannot override latest main; production, branch-protection and external approvals remain separate |

## Evidence-backed completion

- Phase 0 records ORB-001/003/008 as documentation/validation complete; this is not release readiness.
- ORB-002 has local mock inventory evidence, not live cPanel verification; ORB-005 has substantial **CI-only PostgreSQL/Redis integration evidence** but the default HTTP identity remains SQLite. Neither is a production authentication/provider sign-off.
- PR #2 shipped passkey server/UI; PR #3 shipped inventory/revocation/rebinding. CI history is indexed in [`docs/TEST_EVIDENCE/2026-11-10-github-ci.md`](TEST_EVIDENCE/2026-11-10-github-ci.md).
- Current CI checks install, tests, lint, build, smoke and doctor. Virtual-authenticator browser E2E passed in [ORB-012](TEST_EVIDENCE/2026-11-22-orb-012-browser-e2e.md). Physical authenticator, complete accessibility, full production identity/tenant DB migration, off-host/host-failure recovery and live provider verification remain open. Hosted service schema/Redis checks passed in [ORB-016](TEST_EVIDENCE/2026-11-22-orb-016-services-ci.md). ORB-015 now verifies the PR's npm audit, scoped secret/license scans and uploaded lockfile SBOM; full release compliance/schema validation are separate.

## Blocker interpretation

- ORB-004 now includes a hosted, explicitly opted-in **synthetic** PostgreSQL job/outbox and Redis Streams worker with real child-process SIGKILL/lease recovery evidence. SQLite identity/account/audit remain a hybrid test fixture; complete PostgreSQL migration, trusted runtime write-role isolation, host-crash/off-host durability and live provider verification remain open. Disposable Compose named-volume and Redis AOF recreation have passed [ORB-016](TEST_EVIDENCE/2026-11-22-orb-016-compose-recreation.md).
- ORB-006/019 require an authorized disposable provider account.
- ORB-009/018 are **testing/browser_tested**: Chromium native zoom and 200% font-only simulation found/fixed four CSS faults; manual WCAG and native Firefox/WebKit coverage remain open.
- ORB-007 covers local preflight; ORB-017 gates production services and upgrade/recovery.
- New work must record exact commit and workflow evidence. Historical task commit mappings remain null where the audit cannot attribute a precise commit.
