# Architecture baseline

## Decision

Use a TypeScript modular monolith for the web API and worker, with a React/TypeScript web client, PostgreSQL as the production metadata/workflow database, and Redis/BullMQ for distributed background jobs. Use Docker Compose as the documented VPS/self-hosting path when Docker is available. Keep local-only SQLite support behind an explicit local adapter for single-user development; do not treat it as feature-equivalent production deployment. See `docs/DECISIONS/ADR-0001-architecture.md`.

## Boundaries

UI -> authenticated API -> identity/tenant/policy -> domain modules -> transaction/audit/outbox -> queue -> isolated workers -> provider adapters. Secrets are vault references. Workers re-check tenant/action policy immediately before remote work. Providers are ports/adapters and expose a capability snapshot; UI never assumes a capability from a product name or username.

## Synthetic recovery integration (2026-11-23)

[CI-only isolated PostgreSQL 16 recovery proof](TEST_EVIDENCE/2026-11-23-orb-016-isolated-encrypted-restore.md) exercises authenticated fixture archive encryption and an entirely separate Docker PostgreSQL cluster, retaining owner/GRANT/RLS restrictions and testing actual nonowner tenant reads. **This is not the deployment architecture or production backup subsystem**: both clusters run on one disposable Actions runner with no independent vault, object lock, recoverable key escrow or full SQLite/Redis/MFA state. Default HTTP authentication remains SQLite; no automatic Postgres promotion.

## Synthetic signal rejection boundary (2026-11-23)

[PostgreSQL-backed synthetic Redis rejection evidence](TEST_EVIDENCE/2026-11-23-orb-004-poison-signal-quarantine.md) adds a forced-RLS, tenant+Redis-entry unique, **metadata-only** poison reason record, persisted **before** Redis consumer ACK. Write failure leaves the signal pending; crash after committed write but before ACK is handled by idempotent reclaim. It is **not** a production DLQ, provider command authorization or durable signed publisher provenance, and no default HTTP routes are changed. The standalone synthetic-only worker remains explicitly opt-in.

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
