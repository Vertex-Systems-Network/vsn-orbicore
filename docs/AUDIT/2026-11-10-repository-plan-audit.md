# Repository and plan audit — 2026-11-10

## Scope

Read the GitHub repository `Vertex-Systems-Network/vsn-orbicore` at baseline `fac13611c21cfbeec6148a7cbd93a0799dfc4c45`. Reviewed the master directive, agent entry points, README, project state, backlog/task and epic indexes, next action/handoff, security/UX/test/ADR records, CI workflow and recorded CI history. No local repository copy was created or edited.

## Findings and repairs

| Finding | Repair |
|---|---|
| Backlog and several security/UX documents said passkeys were absent even though PRs #2/#3 had merged implementation and management controls. | Updated state, known issues, threat model, test strategy, ADR and UX spec. Browser and physical-device verification remain explicitly open. |
| Master prompt mixed lifecycle values with evidence labels and used values not present in the backlog. | Section 10 now separates `status`, `verification_level`, and `blocker_type`; current machine and human backlogs use the same vocabulary. |
| ORB-011 and ORB-010 bundled unrelated verification gates; ORB-007 was blocked behind unavailable production services. | Added bounded ORB-012–019 tasks; split local installer preflight from production install/upgrade gates. |
| ORB-004/009 treated prior execution-environment failures as permanent capability blockers. | Kept explicit environment blockers but made hosted service/browser runner attempts the next acceptance step. |
| New tasks initially lacked validator-required epic mappings and test-evidence IDs. | Registered every task in `knowledge-bank/backlog/delivery.json` and all referenced test IDs in `knowledge-bank/test-evidence/evidence.json`. |
| Agent instructions required local edits/clone then push, conflicting with the user's GitHub-only repo workflow. | Made GitHub-only branch/PR/Actions/review/merge policy canonical across `AGENTS.md`, Claude, Cursor, Gemini, Copilot, compatibility docs, and the master-prompt override. |
| Handoff and CI evidence were behind current main. | Replaced stale task-start handoff with verified PR/commit/run links and explicit verification limits. |

## CI and correction history

The initial PR run failed because the validator reported missing mappings/test IDs for the newly split tasks. That failure was used as actionable audit evidence; epic mappings and test records were added. GitHub Actions then passed on commit `be4739a8e954c5428726ba461d508d88a3a8907a` (run [42742130584](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/42742130584)): npm ci, 21 tests, lint, build, smoke, and doctor. Later documentation/evidence commits still require the final PR run before merge.

## Remaining unverified

- Browser virtual-authenticator E2E and physical authenticator behavior.
- Verified recovery-contact delivery, key rotation and backup/restore drill.
- PostgreSQL/Redis service-backed integration, browser accessibility, security scanning/SBOM/license checks.
- Live cPanel/WHM integration and production readiness.

These are not marked complete. Resume from [`docs/NEXT_ACTION.md`](../NEXT_ACTION.md); ORB-012 is the next executable slice.
