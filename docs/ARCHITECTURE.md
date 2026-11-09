# Architecture baseline

## Decision

Use a TypeScript modular monolith for the web API and worker, with a React/TypeScript web client, PostgreSQL as the production metadata/workflow database, and Redis/BullMQ for distributed background jobs. Use Docker Compose as the documented VPS/self-hosting path when Docker is available. Keep local-only SQLite support behind an explicit local adapter for single-user development; do not treat it as feature-equivalent production deployment. See `docs/DECISIONS/ADR-0001-architecture.md`.

## Boundaries

UI -> authenticated API -> identity/tenant/policy -> domain modules -> transaction/audit/outbox -> queue -> isolated workers -> provider adapters. Secrets are vault references. Workers re-check tenant/action policy immediately before remote work. Providers are ports/adapters and expose a capability snapshot; UI never assumes a capability from a product name or username.

## Initial implementation slice

Local PoC: React UI -> local HTTP API -> SQLite -> persistent refresh-job row/worker -> fixture-backed cPanel adapter. This intentionally uses no live endpoint. It validates data contracts and user-visible operation states. It does not prove production Postgres/Redis scale or authentication.

## Production decisions still open

Select exact NestJS modules, ORM/migration tool, authentication provider, secret manager, queue topology, object storage and supported VPS minimums using a working local install and measured resource tests. Avoid a microservice split before an independently deployable boundary is justified.

## Runtime invariants

- All requests and jobs have organization/tenant scope, actor, correlation ID and policy result.
- Provider responses are normalized at adapters and carry fetch time, provider/version/capability provenance and errors.
- Idempotent refreshes may retry; migrations use explicit state machines, checkpoints and compensation.
- No user-controlled URL can trigger arbitrary private-network requests; egress allow-list, DNS resolution and redirects need validation.
- Evidence, not UI assertions, sets capability and completion states.
