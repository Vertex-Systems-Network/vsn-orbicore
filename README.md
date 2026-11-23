# VSN ORBICORE

An AI-assisted control plane for multi-provider hosting operations. The product starts with safe, observable cPanel/WHM inventory and expands toward website operations, migration, verified backups, and agency workflows.

The [master development directive](AI_Native_Multi_Hosting_Master_Prompt.md) governs scope, safety, evidence, and delivery. Its requested capabilities are plans until implemented and verified here.

## Current status

Phase 0 exit criteria are met; Phase 1 is not finished. The default HTTP app uses local SQLite-backed bootstrap/authentication/tenants with WebAuthn virtual-authenticator Chromium E2E, MFA/recovery and sampled 200% font-only accessibility regressions; **these are synthetic/browser checks, not production identity or full WCAG compliance**. Separate GitHub-hosted PostgreSQL 16/Redis 7 schema, authorization, synthetic worker and encrypted fixture-restore integration tests pass, but PostgreSQL is **not** authoritative for default HTTP identity and no full offsite restore/cutover is verified. Live cPanel and mail-provider checks remain owner-authorization blocked. Task statuses/evidence are in [the canonical backlog](backlog/tasks.json); every PR description auto-includes a current task table when GitHub PR write permissions permit it.

## Local development

Requires Node.js 24+ and npm. Run `npm ci`, `npm test`, `npm run lint`, `npm run build`, then launch `npm run dev` (API) and `npm run dev:web` (Vite UI) in separate shells. On first launch, read the one-time owner setup token from `.data/first-admin.token` and enter it at `http://localhost:41750`. For local TOTP/passkeys, set environment variables explicitly (or load a populated `.env` through a separate environment loader), generate a unique TOTP key with `openssl rand -base64 32`, and match the WebAuthn RP ID/origin to the browser URL. Simply copying `.env.example` does not load those variables in the API process. Production passkeys require HTTPS and an exact expected origin. By default both processes bind only to loopback: Vite `127.0.0.1:41750` and API `127.0.0.1:41751`. Non-loopback binds require the explicitly configured `ORBICORE_WEB_HOST` / `ORBICORE_API_HOST` environment variables and must be restricted to authorized isolated test networks; this synthetic application is **not production-ready**. Vite's default host authorization is retained, and API forwarded host/protocol headers are only honored from loopback proxies. The API seeds `.data/orbicore.sqlite` from a synthetic fixture. Start with [contribution guidance](CONTRIBUTING.md), [the next action](docs/NEXT_ACTION.md), and [project state](docs/PROJECT_STATE.md).

## Reproducible, offline official CycloneDX schema validation

GitHub CI verifies the npm-lockfile-only CycloneDX 1.5 SBOM with three exact upstream **vendored** official JSON Schema files. The checker enforces the original Git blob SHA of each local file, size/$id/draft-07 checks, four offline corruption/missing-source tests and three intentionally invalid BOM fixtures. This eliminates live raw.githubusercontent.com schema requests during SBOM validation. See [official schema provenance](vendor/cyclonedx/1.5/PROVENANCE.md), [third-party license notice](docs/THIRD_PARTY_NOTICES.md) and [CI evidence](docs/TEST_EVIDENCE/2026-11-23-orb-010-offline-schema-ci.md). Python dependency installation, operating system/container SBOM coverage and a signed release attestation remain separate.

## Project records

- [Roadmap](docs/ROADMAP.md) and [backlog](docs/BACKLOG.md)
- [Architecture](docs/ARCHITECTURE.md), [security threat model](docs/SECURITY_THREAT_MODEL.md), and [research](docs/RESEARCH/PHASE-0-RESEARCH.md)
- [AI agent rules](AGENTS.md), [PR task-table and plan integrity audit](docs/AUDIT/2026-11-23-ai-plan-pr-governance.md)
