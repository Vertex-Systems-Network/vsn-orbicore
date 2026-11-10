# VSN ORBICORE

An AI-assisted control plane for multi-provider hosting operations. The product starts with safe, observable cPanel/WHM inventory and expands toward website operations, migration, verified backups, and agency workflows.

The [master development directive](AI_Native_Multi_Hosting_Master_Prompt.md) governs scope, safety, evidence, and delivery. Its requested capabilities are plans until implemented and verified here.

## Current status

Phase 0 exit criteria are met. Phase 1 is underway. Local bootstrap/login, tenant scoping, audit, a TOTP compatibility fallback, and one-time recovery codes are mock-tested. Passkey enrollment/login server routes and UI are implemented on the ORB-011 feature branch; browser authenticator verification, verified notification delivery, production key management, PostgreSQL/Redis, and the installation wizard remain unverified. The service uses synthetic data only and does not connect to real hosting accounts or perform production operations.

## Local development

Requires Node.js 24+ and npm. Run `npm ci`, `npm test`, `npm run lint`, `npm run build`, then `npm run dev`. On first launch, read the one-time owner setup token from `.data/first-admin.token` and enter it at `http://localhost:41750`. To enable local TOTP/passkey development, create `.env` from `.env.example`, generate a unique TOTP key with `openssl rand -base64 32`, and keep the WebAuthn RP ID/origin set to the exact host used by the browser. Production passkeys require HTTPS and the deployment's stable hostname as RP ID and exact expected origin. Keep both services local-only and do not use real hosting credentials. The Vite UI listens on `127.0.0.1:41750`; the API listens on `127.0.0.1:41751`. The API seeds `.data/orbicore.sqlite` from a synthetic fixture. Start with [contribution guidance](CONTRIBUTING.md), [the next action](docs/NEXT_ACTION.md), and [project state](docs/PROJECT_STATE.md).

## Project records

- [Roadmap](docs/ROADMAP.md) and [backlog](docs/BACKLOG.md)
- [Architecture](docs/ARCHITECTURE.md), [security threat model](docs/SECURITY_THREAT_MODEL.md), and [research](docs/RESEARCH/PHASE-0-RESEARCH.md)
- [AI agent rules](AGENTS.md)
