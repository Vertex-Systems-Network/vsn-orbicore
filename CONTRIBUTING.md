# Contributing

## Current development mode

This repository is at Phase 0 with a local inventory proof of concept. The environment verified for the current checkpoint has Node.js 24.22.1, npm 11.9.0, and Python 3.12. Docker, PostgreSQL, and Redis are not installed. The supported local mode must therefore document SQLite and the limits of its job worker separately from the eventual multi-node PostgreSQL/Redis deployment.

## Start here

1. Read `AGENTS.md`, `docs/PROJECT_STATE.md`, `docs/NEXT_ACTION.md`, and the relevant backlog task.
2. Check `git status --short --branch`, `package.json`, and listening ports before starting services.
3. Use the lockfile and exact root scripts; install dependencies once with the project package manager.
4. Run focused checks, inspect `git diff --check` and `git diff`, and update `docs/TEST_EVIDENCE/` and state records.
5. Commit a tested atomic checkpoint on an authorized development branch. Do not force-push.

## Tests and external accounts

Fixtures and local SQLite validate local logic only. Live cPanel, WHM, DNS, storage, WordPress, mail, and production workflows need separately authorized sandbox accounts and are not presumed available. Never put real account credentials into test fixtures.
