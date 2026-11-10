# VSN ORBICORE agent rules

This file is canonical. The product charter is `AI_Native_Multi_Hosting_Master_Prompt.md`; current state is `docs/PROJECT_STATE.md`; next work is `docs/NEXT_ACTION.md`; prioritized tasks are `backlog/tasks.json` and `docs/BACKLOG.md`.

## Resume order

1. Verify the exact repository `Vertex-Systems-Network/vsn-orbicore`, current GitHub ref/commit, branches, open PRs, and latest checks.
2. Read this file, project state, roadmap, backlog, architecture, known issues, handoff, ADRs, and applicable knowledge-bank records from that same ref.
3. Read applicable master-directive sections. Research uncertain or time-sensitive facts from official sources and record them in `docs/RESEARCH/`.
4. Select one highest-priority unblocked task; preserve existing work and avoid duplicates.
5. All project work is GitHub-only: branch from current `main`, edit through GitHub, run checks in GitHub Actions, review PR diff/checks, merge only after required checks pass. Do not clone or make a local-only checkpoint. If GitHub tools cannot perform a required operation, record the exact constraint and preserve the last remote checkpoint.

## Product and security constraints

- Operate only within connected provider/account capabilities; never infer root/WHM privileges from cPanel credentials.
- Read-only inventory is the first live integration goal. Fixtures are mock evidence, not live verification.
- Never persist raw credentials/tokens in source, jobs, logs, fixtures, screenshots, telemetry, or AI context.
- Treat endpoint URLs, domains, filenames, user strings, and provider responses as untrusted; design SSRF, traversal, injection, replay, and tenant-isolation controls before external operations.
- Destructive, costly, DNS-affecting, or production actions require explicit scoped authorization and recoverable evidence.
- Label facts measured/estimated/configured/unsupported/unknown. Never invent test results, integration behavior, progress, or zero-downtime claims.
- Do not enable a persistent autonomous runner unless the operator explicitly configures credentials, scope, budget, and schedule.

## Engineering and design

- Modular monolith first; version stable contracts; isolate provider adapters behind interfaces.
- Use strict TypeScript, validated inputs, migrations, tenant-scoped data access, accessible UI, and clear empty/loading/error/permission states.
- Every visible control must work truthfully or be disabled with its dependency explained.
- Restrictive shared cPanel hosting is not an assumed deployment target for the central application.
- Avoid empty scaffolds and premature desktop/mobile packages; build web/API/install foundations first.

## GitHub workflow and verification

- Never write directly to `main`; use a purpose-specific feature branch and PR in this repository.
- Check current base and diff before remote commits; preserve unrelated work; never force-push or rewrite shared history.
- Record workflow URL, tested head SHA, commands/jobs, outcome, and limitations in `docs/TEST_EVIDENCE/` and `docs/HANDOFF.md`.
- Keep task lifecycle separate from verification strength. Do not set `verified` without recorded evidence.
- Merge only after required checks pass, then verify resulting `main` SHA and update state. Claim push/merge only when GitHub confirms it.

## Resume

CI commands are defined in `.github/workflows/ci.yml`; `package.json` commands are contributor reference only for this repo's GitHub-only workflow. The exact next task is `docs/NEXT_ACTION.md`.
