# Contributing

## Current development mode

Phase 0 exit criteria are met and Phase 1 is underway with a local inventory and authentication proof of concept. The original local-only checkpoint used Node.js 24.22.1, npm 11.9.0, and Python 3.12 without local Docker/PostgreSQL/Redis; this is **historical** and does not describe GitHub-hosted service runners. Later GitHub CI has passed real **synthetic** PostgreSQL 16 and Redis 7 integration jobs and virtual-authenticator Chromium browser tests. These do not establish deployed production readiness. The local mode uses SQLite and a single-process worker. First startup writes the one-time owner token to `.data/first-admin.token`; sign-in and tenant scopes are for synthetic local testing only. The eventual multi-node deployment requires PostgreSQL/Redis and a separate production identity/security review.

## Start here

1. Read `AGENTS.md`, `docs/PROJECT_STATE.md`, `docs/NEXT_ACTION.md`, and the relevant backlog task.
2. For this repository's **AI GitHub-only** workflow, inspect the remote branch/PR, `package.json` and the last GitHub Actions runs; do **not** clone, modify local worktrees or run commands outside authorized GitHub Actions. Human contributors operating an authorized local checkout can inspect local Git status and ports.
3. Use the lockfile and exact root scripts; install dependencies once with the project package manager.
4. Run focused checks, `npm run smoke`, inspect `git diff --check` and `git diff`, and update `docs/TEST_EVIDENCE/` and state records.
5. On the authorized development branch, **update affected task statuses, evidence and blocker details** in `backlog/tasks.json` and `docs/BACKLOG.md` when facts change; commit and push a tested checkpoint without force-push. Open a PR with linked ORB IDs, CI artifacts and limitations. The trusted-base PR ledger Action renders the complete live task table inside the PR description and refreshes it on commits/edits; verify that it actually ran. Missing PR bot write permissions are a blocker, not an invisible success.

## Tests and external accounts

Fixtures and local SQLite validate local logic only. Live cPanel, WHM, DNS, storage, WordPress, mail, and production workflows need separately authorized sandbox accounts and are not presumed available. Never put real account credentials into test fixtures.
