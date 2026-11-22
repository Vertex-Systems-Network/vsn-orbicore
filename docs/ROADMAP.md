# Roadmap and objective exits

The product roadmap follows Sections 17 and 21 of the master directive. Phases are gates, not percentage claims.

| Phase | Scope | Exit evidence | Current status |
|---|---|---|---|
| 0 | Research, feasibility, permissions, workflows, architecture, UX, backlog, mock inventory PoC | Current official-source research, weighted ADR, populated banks/specs, internally consistent diagrams, local PoC tests | Complete; exit evidence recorded in `docs/TEST_EVIDENCE/2026-11-09-local-poc.md` |
| 1 | Web/API shell, auth/tenants, PostgreSQL, durable jobs, policy/audit, doctor, installer skeleton | Fresh local install and walkthrough; auth/tenant isolation; jobs and recovery tests | Local SQLite/API/UI & team RBAC implemented; Compose/SQL parity prepared; Docker/PostgreSQL & browser E2E pending |
| 2 | cPanel/WHM connection and inventory | Mock suite plus authorized live inventory with isolation, staleness and errors | Mock fixture & read-only UAPI client boundary implemented; live test blocked (no authorized sandbox) |
| 3 | Permission-aware management operations | Reversible operations with evidence and policy tests | Capability-gated site inspection & dry-run snapshots implemented locally; live proof blocked external |
| 4 | Migration engine | Local and authorized sandbox proof of checksum, partial failure, rollback and DNS gate | Dry-run state machine, 30% failure checkpoint/resume, cutover gate & rollback tested locally; live blocked external |
| 5 | Storage engine | Verified offload, rehydration and restore drill; actual measured savings | Dry-run policy planner, outage fail-closed & rehydration verification drills tested locally; live bucket blocked external |
| 6 | WordPress lifecycle | Update/staging rollback on disposable test sites | Dry-run staging clone, pre-update restore snapshot & rollback tested locally; live test site blocked external |
| 7 | Automation and AI guidance | Deterministic, audited, policy-gated execution; AI read-only insights grounded in timestamps | Implemented locally: deterministic telemetry advisor & policy-gated dry-run rules with daily run caps |
| 8 | Agency readiness | Multi-client reporting, API, security/accessibility/performance gates, install/release artifacts | Portfolio readiness JSON report & supply-chain/SBOM gate implemented locally; CI/a11y/perf gates remain |
| 9 | Desktop | Signed/appropriate Windows/macOS/Linux clients against stable API | Deferred until web API stabilizes |
| 10 | Mobile | Android/iOS clients and distribution/device evidence | Deferred until web API stabilizes |

Phase 0 met its stated exit: required research/specs/banks are present, internal IDs/links validate, and the local proof-of-concept test suite passes. Browser accessibility QA remains a Phase 1 task and is explicitly blocked by this environment, not represented as a pass. Never close later phases from optimistic scoring. Track each task status and evidence in `backlog/tasks.json`.
