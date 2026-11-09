# Executable backlog

Canonical machine-readable tasks: [`backlog/tasks.json`](../backlog/tasks.json). Keep this summary synchronized with it. `verified` means the acceptance criteria have reproducible evidence; `implemented_unverified` is not complete. A mock pass cannot imply live provider support. `mock_tested` means local fixture-driven checks only; it is not release readiness.

## Current critical path

| ID | Task | Priority | Status | Exit condition |
|---|---|---:|---|---|
| ORB-001 | Phase 0 research, risk/permission matrix, ADR and product scope | P0 | verified | Dated sources, tradeoffs, unknowns and architecture decision recorded |
| ORB-002 | Local mock cPanel inventory vertical slice | P0 | mock_tested | API + persisted DB + worker + interactive UI and repeatable tests |
| ORB-003 | Persistent AI rules, docs, diagrams and knowledge banks | P0 | verified | Populated, cross-linked sources of truth; no empty compliance files |
| ORB-004 | PostgreSQL/Redis deployment and durable worker proof | P1 | blocked_external | Docker/PostgreSQL/Redis runtime available; Compose health/readiness and restart recovery verified |
| ORB-005 | Authentication, tenant isolation, scoped policy and audit | P1 | in_progress | Threat model and tests block unauthenticated/cross-tenant access before provider secrets |
| ORB-006 | Authorized live cPanel UAPI inventory adapter | P1 | blocked_external | Owner-authorized disposable account, least-privilege token, test matrix and revoked-token test |
| ORB-007 | Secure install wizard preflight and first-admin bootstrap | P1 | proposed | Idempotent setup, secret generation, recovery, redacted diagnostic and fresh install test |
| ORB-008 | Research/decision bank validation and schema tooling | P0 | verified | JSON schema validation and generated cross-reference report |
| ORB-009 | UX accessibility and browser visual verification | P1 | blocked_environment | Keyboard, contrast, screen-reader, empty/error/permission states and screenshot comparison |
| ORB-010 | Threat-model security suite and dependency/SBOM scanning | P1 | proposed | SSRF, injection, tenant, secret, replay, dependency and license gates in CI |

## Completed in this checkpoint

- ORB-001 research and architecture decision satisfy the recorded Phase 0 acceptance criteria; estimated scores and open unknowns are explicitly labeled.
- ORB-003 documentation/bank structure passes schema, unique-ID, test-ID, and local-path validation (`npm run lint`).
- ORB-008 schema/cross-reference validator is implemented and covered by the local test suite.

## Dependencies and blockers

- ORB-009 was attempted in the shared browser, but its isolated environment could not reach the local loopback server. A Playwright Chromium download from the official CDN returned a truncated 0 MiB archive. Browser visuals and interactions remain unverified.
- ORB-005 authentication and tenant enforcement must be verified before any connector credentials are added; the current demo API has no authentication and must remain synthetic-only.

- ORB-004 cannot be verified in this environment because Docker, PostgreSQL, and Redis are absent. The code/config may still be authored, but do not close it.
- ORB-006 and all live transfer/storage/WordPress/mail tests need owner-authorized sandbox accounts. Do not use customer production accounts by inference.
- ORB-005 must precede any real credential entry or provider mutation.
