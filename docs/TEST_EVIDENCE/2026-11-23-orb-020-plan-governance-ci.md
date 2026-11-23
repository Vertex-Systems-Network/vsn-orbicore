# ORB-020 — AI plan integrity, PR ledger and CI warning governance

**Date:** 2026-11-23
**GitHub PR:** [#51](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/51)
**Tested functional head:** `c4fbc3728bfe353b5a0fb51d635cb3ff5c28ae3e`
**Mode:** GitHub-only branch/PR/Actions (no local clone).

## Verified functional CI

| Runner / workflow | Hosted run | Result |
| --- | --- | --- |
| Standard PR CI | [#45136560073](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45136560073) | **Success**, 122/122 Node tests, 0 fail, `npm run lint` (72 schema-validated bank records), 20-task plan integrity, secret/license/SBOM official schema validation, audit, build, smoke and doctor. |
| Feature-branch CI | [#45136554911](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45136554911) | **Success**. |
| Chromium virtual WebAuthn, real native 100/200/400% zoom and sampled 200% font-only resize | [#45136560103](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45136560103) | **Success**. |
| PostgreSQL16/Redis7 hosted service matrix | [#45136560088](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45136560088) | **23/23 jobs successful** with updated Node24-compatible artifact/checkout/setup actions; all tests remain **synthetic CI-only**, not production service proof. |

## Errors and warning corrections proved

- `backlog/tasks.json`: ORB-002 `verified_at` erroneously non-null while status `testing`; reset to null, documented live-external provider gate. ORB-014 human record `unit` contradicted machine `mock_tested`; aligned. Added ORB-020 and epic/test ID mapping. Other task statuses remain facts, not automatically promoted.
- `scripts/validate-banks.mjs`: previously returned on arrays before `schema.items`, silently skipping nested array validation. Corrected; lint now validates actual items and all 72 bank records with no errors.
- `scripts/audit-plan.mjs` and 9 new Node tests: reject invalid task status, false verified timestamp, missing blockers, broken epic mapping, cycle and Markdown drift; package lint runs guard on every PR.
- Historic roadmap **44-test** metric corrected to a dated pre-audit 113-test run; README, Test Strategy, product historical PoC statement, Known Issues and agents updated to reflect synthetic PostgreSQL and WebAuthn browser proofs without production claims.
- npm 11 warning about the **unreviewed install script for locked `esbuild@0.28.2`** no longer appears in the tested CI. Explicit version-specific `allowScripts` approval (lockfile has SHA512 integrity metadata) + `.npmrc` `strict-allow-scripts=true` deny new unknown scripts. No global approval bypass.
- Node20 action deprecation warning previously raised for `checkout@v4`, `setup-node@v4`, `setup-python@v5`, `upload-artifact@v4`, and `download-artifact@v4`. All four workflows migrated to Node24-compatible `checkout@v5`, `setup-node@v5`, `setup-python@v6`, `upload-artifact@v6`, `download-artifact@v7`. **No Node20 action compatibility warning in the final standard or browser run**. Service matrix succeeded with the replacements.

## PR description automation — validated vs unvalidated

The formatter and fail-closed PR ledger unit tests passed in hosted CI, and **PR #51 had its complete 20-task description table inserted manually before automation existed on the default branch**. A new `pull_request_target` workflow checks out **only default-branch trusted code**, reads bounded PR-head backlog JSON and patches a marked PR-body section idempotently. Main backlog pushes update all open PRs. Production credentials and PR-head scripts are never executed.

**Not yet verified at this checkpoint:** the workflow has not executed after merging into main; GitHub App token `pull-requests:write` effective permission and webhook opened/synchronize/edited behavior must be tested with an actual subsequent PR. ORB-020 remains `testing/unit` until that independent check is recorded. GitHub branch protection check returned **403**, so actual enforced repo rules remain unknown.

## Remaining runtime warnings and blockers (not suppressed or falsely fixed)

- Node24 runtime emits `DEP0040 punycode` and `DEP0169 url.parse()` warnings in tooling or transitive dependencies and experimental WebCrypto ML-DSA warnings. Build/tests **pass**, but these runtime warnings are still visible; no blanket `NODE_NO_WARNINGS` suppression was added. Audit their originating stack and upgrade supported dependencies in a later isolated PR.
- ORB-006/019 require explicit owner-authorized disposable cPanel sandbox credentials; ORB-013 live notification transport, external KMS/witness immutable storage, full PostgreSQL HTTP identity migration, off-host backup and production deployment still not verified. Those are **not** resolved by PR-status automation.
- No automatic completion/verified flag was generated. 20 tasks: verified 5, testing 10, in progress 3, blocked 2.

## Authoritative source and method notes

- [Audit decision record](../AUDIT/2026-11-23-ai-plan-pr-governance.md)
- [npm 11 install script approvals](https://docs.npmjs.com/cli/v11/commands/npm-install-scripts/)
- [GitHub Actions Node 20 transition](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/)
