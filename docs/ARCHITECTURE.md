# Architecture baseline

## Decision

Use a TypeScript modular monolith for the web API and worker, with a React/TypeScript web client, PostgreSQL as the production metadata/workflow database, and Redis/BullMQ for distributed background jobs. Use Docker Compose as the documented VPS/self-hosting path when Docker is available. Keep local-only SQLite support behind an explicit local adapter for single-user development; do not treat it as feature-equivalent production deployment. See `docs/DECISIONS/ADR-0001-architecture.md`.

## Boundaries

UI -> authenticated API -> identity/tenant/policy -> domain modules -> transaction/audit/outbox -> queue -> isolated workers -> provider adapters. Secrets are vault references. Workers re-check tenant/action policy immediately before remote work. Providers are ports/adapters and expose a capability snapshot; UI never assumes a capability from a product name or username.

## Synthetic recovery integration (2026-11-23)

[CI-only isolated PostgreSQL 16 recovery proof](TEST_EVIDENCE/2026-11-23-orb-016-isolated-encrypted-restore.md) exercises authenticated fixture archive encryption and an entirely separate Docker PostgreSQL cluster, retaining owner/GRANT/RLS restrictions and testing actual nonowner tenant reads. **This is not the deployment architecture or production backup subsystem**: both clusters run on one disposable Actions runner with no independent vault, object lock, recoverable key escrow or full SQLite/Redis/MFA state. Default HTTP authentication remains SQLite; no automatic Postgres promotion.

## CI-only signed and anchored Redis worker notifications (2026-11-23)

[Real PG16/Redis7 signed-wakeup hosted proof](TEST_EVIDENCE/2026-11-23-orb-004-signed-wakeup.md) explicitly injects a versioned HMAC signer/verifier with an ephemeral CI-only key. Each synthetic Redis XADD carries an allowlisted HMAC of tenant/job/outbox UUID, and the already scoped SQL worker gateway checks **that exact Redis-assigned stream ID** equals the committed PG outbox receipt before any job claim. New migration 017 versions the metadata-only rejection enum and restricted recorder function. Signatures alone never authorize real providers; no production signing-key custody, broker ACL, durable key recovery, actual HTTP PostgreSQL auth or live runtime changes have occurred.

## CI-only full nonowner synthetic worker SQL boundary (2026-11-23)

[Real PG16/Redis7 hosted 22-job evidence](TEST_EVIDENCE/2026-11-23-orb-004-full-worker-gateway.md) replaces privileged direct SQL *in an explicitly injected synthetic worker fixture* with fixed tenant-bound SECURITY DEFINER functions and an authenticated login→tenant database mapping. It holds one PostgreSQL row lock across Redis publish, preventing same-intent concurrent selection, and commits mock-only completion only after **transactional recheck of actor and account** under locks. Function role lacks raw table grants; nonowner login cannot escalate or switch tenant through a GUC. The default standalone service still uses the prior privileged CI pool, and neither Redis producer authentication nor full real-provider policy has been implemented. No PostgreSQL HTTP login cutover.

## CI-only principal-bound signal rejection gateway (2026-11-23)

[Hosted restricted PostgreSQL 16 role proof](TEST_EVIDENCE/2026-11-23-orb-004-scoped-signal-writer.md) adds an admin-managed authenticated SQL login→tenant scope and a NOLOGIN recorder with fixed-signature privileged SQL functions, default PUBLIC EXECUTE revoked and no direct table/user privileges. A separate restricted PG connection is injectable **only for the synthetic Redis rejection suboperation**, preserving fail-closed rejection-before-XACK and Redis PEL recovery. General worker job queries remain privileged CI fixtures. This is not production worker access, provider authorization or real PostgreSQL authentication.

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
