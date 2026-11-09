# VSN ORBICORE agent rules

This file is canonical. The product charter is `AI_Native_Multi_Hosting_Master_Prompt.md`; current state is `docs/PROJECT_STATE.md`; next work is `docs/NEXT_ACTION.md`; prioritized tasks are `backlog/tasks.json` and `docs/BACKLOG.md`.

## Resume order

1. Run `git status --short --branch`, `git log -5 --oneline`, and inspect the repo tree.
2. Read this file, project state, roadmap, backlog, architecture, known issues, latest handoff, ADRs, and applicable knowledge-bank records.
3. Read the master directive sections that apply to the task. Check current official sources only for uncertain or time-sensitive facts and record them in `docs/RESEARCH/`.
4. Select one highest-priority unblocked task. Preserve existing changes and avoid duplicate work.
5. Implement locally, run the narrowest relevant checks plus required acceptance tests, inspect the diff, update evidence/state, then commit and push to the authorized development branch. Never label implementation `verified` without recorded evidence.

## Product and security constraints

- The system orchestrates only operations the connected provider/account explicitly permits. Discover capabilities; never infer root/WHM privileges from cPanel credentials.
- Read-only inventory is the first live integration goal. Seeded fixtures are `MOCK-TESTED`, not live provider verification.
- Never persist raw credentials or tokens in source, jobs, logs, fixtures, screenshots, telemetry, or AI context. Use secret references and redact output.
- Treat endpoint URLs, domains, filenames, user strings, and provider responses as untrusted. Design SSRF, path traversal, injection, replay, and tenant isolation controls before enabling external operations.
- All destructive, costly, DNS-affecting, or production actions require explicit authorization/policy and recoverable evidence. Never delete the source during migration before verified recovery gates.
- Label facts `measured`, `estimated`, `configured`, `unsupported`, or `unknown`. Do not fake integrations, tests, progress, or zero-downtime claims.
- Do not enable a persistent autonomous runner unless the operator explicitly configures its credentials, scope, budget, and schedule.

## Engineering and design

- Modular monolith first; version stable contracts; isolate provider adapters behind interfaces.
- Use strict TypeScript in application code, validated inputs, migrations, tenant-scoped data access, accessible UI, clear empty/loading/error/permission states, and responsive design.
- Every visible control must have a truthful working behavior or be clearly disabled with its dependency explained.
- Keep deployment requirements truthful: restrictive shared cPanel hosting is not an assumed host for this central application.
- Avoid empty scaffolds and premature desktop/mobile packages. Build web/API/install foundations first.

## Git and verification

- Check working tree before edits and preserve unrelated changes.
- Do not force-push or rewrite shared history. Prefer a feature branch and atomic conventional commits.
- Run lint/typecheck/unit/contract/integration/UI checks relevant to changed behavior. Record commands, versions, exit codes, commit, and unresolved blockers under `docs/TEST_EVIDENCE/` and `docs/HANDOFF.md`.
- Do not install dependencies repeatedly without a reason; discover runtime, lockfile, services and occupied ports first. Keep long-running processes bounded and clean them up.
- Before checkpoint, review `git diff --check`, `git diff`, and secret scans. Push only after local checks; if auth/network blocks push, report the exact blocker and retain the local commit.

## Canonical commands and resume

Use root package scripts once created: `npm run dev`, `npm run test`, `npm run lint`, `npm run typecheck`, `npm run build`, and `npm run doctor`. Check `package.json` before assuming a command exists. The exact current next step is `docs/NEXT_ACTION.md`.
