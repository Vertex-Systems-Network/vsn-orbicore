# AI master plan and PR task governance audit — 2026-11-23

**Scope:** authoritative GitHub `Vertex-Systems-Network/vsn-orbicore` at `cab7f02fc0c49f7651c3dd7f004e341d677cecae`; master directive, root agent/adapters, canonical 19-task JSON, delivery epic map, human backlog, project state, roadmap, test strategy, README, Known Issues, CI workflows, validator and most recent hosted logs. All work GitHub-only; no local clone.

## Findings and corrections in PR #51

| Classification | Measured finding | Remediation |
| --- | --- | --- |
| **Error** | ORB-002 lifecycle `testing` incorrectly retained `verified_at=2026-11-09`, a misleading completion timestamp. | Set `verified_at=null`; retain `mock_tested` and external live provider blocker. |
| **Error** | Human backlog ORB-014 said `unit` but canonical task says `mock_tested`. | Align task row to canonical without fake verification promotion. |
| **Error** | `scripts/validate-banks.mjs` returned early for array values, skipping `schema.items` validation entirely. | Traverse array items before object branch; preserve existing JSON Schema enum and type checks. |
| **Governance gap** | No task status table in PR descriptions and no refresh on each PR push/edit or changes to canonical main backlog; an agent can change docs while leaving task statuses stale. | Trusted-base, idempotent GitHub PR ledger action; task/commit delta; new PR template and canonical instructions. No PR head execution in write-token job. |
| **Governance gap** | No separate canonical-status/verification-date, blocker-type, dependency-cycle and human-vs-JSON backlog CI contract. | New `scripts/audit-plan.mjs` gate in lint with negative regression fixtures. |
| **Outdated plan** | `docs/ROADMAP.md` reports `44-test CI`, despite 113 Node tests in last full PR #50. `README`, `TEST_STRATEGY` and KI-006 still say WebAuthn virtual browser, hosted PostgreSQL/Redis, or official CycloneDX schema checks are unavailable. | Update as dated, accurately scoped hosted-CI evidence; distinguish CI-only proof from deployed PostgreSQL HTTP or real providers. |
| **Blocker clarity** | ORB-006/019 genuinely lack owner-authorized disposable cPanel credentials, while external KMS, SMTP, off-host restore and production cutover remain unapproved. | Preserve `blocked` / `external` or honest in-progress technical blockers. Do not invent access, release approval or new provider results. |
| **Unknown policy** | Branch protection endpoint returned HTTP 403 to current integration (read permission denied). | Do not claim required branch checks are enforced; continue explicit PR review and full CI verification. Owner/repo administrator must inspect repository rules independently. |

## New task ORB-020

A P1 bounded task is registered in `backlog/tasks.json` and the Phase 1 epic with test ID `PLAN-GOV-001`. Lifecycle stays `testing` until the trusted-base Action has **actually** updated a live open PR body and its head-table refresh is observed. Unit-only workflow simulation is not remote webhook evidence.

## PR event safety boundary

The write-enabled `pull_request_target` handler checks out the repository's **trusted default branch**, never PR-head code; it reads only bounded task JSON from the PR head using GitHub contents API, renders an escaped Markdown table, and updates that same PR body. `push` on main backlog changes refreshes all open PRs (up to a fail-closed pagination bound). Authored text is kept outside delimiters; duplicate/missing markers reject editing. Permissions are `contents:read` and `pull-requests:write` only; no shell interpolation from PR title/body, no deployment or production credential access.

## Exit criteria still open

Host CI must pass at the final code+docs head. Then merge PR #51. Since GitHub only loads new `pull_request_target` workflows after their default-branch merge, use a real follow-up PR to check **opened, synchronize and edited** table operations; record exact workflow URLs/head/diff and update ORB-020 only after this proof. Continue ORB-005 PostgreSQL production-shaped identity, ORB-004/016/017 production recovery and ORB-006/019 authorized cPanel work as separate blocked/partial tracks. **Do not** conflate governance CI with product release completion.

## Additional CI warning remediation

The actual hosted PR CI `#45136166942` reported Node.js 20 action-runtime deprecations from `actions/checkout@v4`, `setup-node@v4`, `setup-python@v5`, and `upload-artifact@v4`; services workflow also invoked `download-artifact@v4`. Updated all four workflows to the first official Node 24-compatible major tags: checkout v5, setup-node v5, setup-python v6, upload-artifact v6 and download-artifact v7. The updated services artifact producer/consumer flow must be verified on GitHub Actions before merge; do not claim warning-free until those runs finish. Official sources: [GitHub's Node 20 deprecation announcement](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/), [upload-artifact Node 24 release](https://github.com/actions/upload-artifact/releases), [download-artifact Node 24 release](https://github.com/actions/download-artifact/releases).

## Measured functional CI checkpoint

At SHA `c4fbc3728bfe353b5a0fb51d635cb3ff5c28ae3e`, [PR CI #45136560073](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45136560073) passed 122/122 tests and plan/schema audit; [branch CI #45136554911](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45136554911) passed, [Chromium #45136560103](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45136560103) passed, and [PG16/Redis7 #45136560088](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45136560088) passed all 23 service jobs. npm esbuild and deprecated Node20 action annotation warnings are gone. Node24 punycode/url.parse and experimental WebCrypto warnings remain; do not hide them. [Full evidence](../TEST_EVIDENCE/2026-11-23-orb-020-plan-governance-ci.md). PR webhook write permission and branch protection remain unverified until after merge.
