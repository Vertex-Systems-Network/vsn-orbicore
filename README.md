# VSN ORBICORE

An AI-assisted control plane for multi-provider hosting operations. The product starts with safe, observable cPanel/WHM inventory and expands toward website operations, migration, verified backups, and agency workflows.

The [master development directive](AI_Native_Multi_Hosting_Master_Prompt.md) governs scope, safety, evidence, and delivery. Its requested capabilities are plans until implemented and verified here.

## Current status

Phase 0 exit criteria are met. Phase 1 is underway; authentication, tenant isolation, PostgreSQL/Redis integration, and the installation wizard remain unverified. The local inventory proof of concept is implemented and mock-tested with seeded cPanel-shaped data and local SQLite; it does not connect to real hosting accounts or perform production operations. PostgreSQL and Redis integration, authentication, tenant isolation, and the installation wizard remain unverified.

## Local development

Requires Node.js 24+ and npm. Run `npm ci`, `npm test`, `npm run lint`, `npm run build`, then `npm run dev`. The Vite UI listens on `127.0.0.1:41750`; the API listens on `127.0.0.1:41751`. The API seeds `.data/orbicore.sqlite` from a synthetic fixture. Start with [contribution guidance](CONTRIBUTING.md), [the next action](docs/NEXT_ACTION.md), and [project state](docs/PROJECT_STATE.md).

## Project records

- [Roadmap](docs/ROADMAP.md) and [backlog](docs/BACKLOG.md)
- [Architecture](docs/ARCHITECTURE.md), [security threat model](docs/SECURITY_THREAT_MODEL.md), and [research](docs/RESEARCH/PHASE-0-RESEARCH.md)
- [AI agent rules](AGENTS.md)
