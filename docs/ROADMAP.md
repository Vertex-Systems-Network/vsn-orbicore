# Roadmap and objective exits

The product roadmap follows Sections 17 and 21 of the master directive. Phases are gates, not percentage claims.

| Phase | Scope | Exit evidence | Current status |
|---|---|---|---|
| 0 | Research, feasibility, permissions, workflows, architecture, UX, backlog, mock inventory PoC | Current official-source research, weighted ADR, populated banks/specs, internally consistent diagrams, local PoC tests | In progress |
| 1 | Web/API shell, auth/tenants, PostgreSQL, durable jobs, policy/audit, doctor, installer skeleton | Fresh local install and walkthrough; auth/tenant isolation; jobs and recovery tests | Not started; dependencies on Phase 0 decisions |
| 2 | cPanel/WHM connection and inventory | Mock suite plus authorized live inventory with isolation, staleness and errors | Blocked external for live provider |
| 3 | Permission-aware management operations | Reversible operations with evidence and policy tests | Not started |
| 4 | Migration engine | Local and authorized sandbox proof of checksum, partial failure, rollback and DNS gate | Not started; live proof blocked external |
| 5 | Storage engine | Verified offload, rehydration and restore drill; actual measured savings | Not started; storage account blocked external |
| 6 | WordPress lifecycle | Update/staging rollback on disposable test sites | Not started; test site blocked external |
| 7 | Automation and AI guidance | Deterministic, audited, policy-gated execution; AI read-only insights grounded in timestamps | Not started |
| 8 | Agency readiness | Multi-client reporting, API, security/accessibility/performance gates, install/release artifacts | Not started |
| 9 | Desktop | Signed/appropriate Windows/macOS/Linux clients against stable API | Deferred until web API stabilizes |
| 10 | Mobile | Android/iOS clients and distribution/device evidence | Deferred until web API stabilizes |

Never close a phase from optimistic scoring. Track each task status and evidence in `backlog/tasks.json`.
