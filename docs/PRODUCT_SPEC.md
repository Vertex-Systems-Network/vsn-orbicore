# Product specification (Phase 0 baseline)

## Mission and users

VSN ORBICORE is a self-hostable web-first control plane for owners, WordPress operators, agencies, resellers, hosting administrators and read-only clients managing resources across independently controlled providers. It centralizes inventory and provides capability-aware workflows while respecting provider and account permission boundaries.

## MVP boundary

The first technical proof is read-only inventory of mock cPanel accounts and sites through a provider adapter. It demonstrates a real local API, persisted records, a job lifecycle and an interactive dashboard. It does not manage live hosting, migrate a website, manage secrets, implement authentication or establish production suitability.

## User jobs and initial flows

1. Add a hosting connection using the least-privileged supported mechanism and validate it without exposing credentials.
2. Discover account-level capabilities, domains/sites and resource health; show provenance and last-synced time.
3. Search/filter sites and identify stale, failed, unsupported, or restricted resources.
4. Preview migrations and storage actions; later require policy approval, verified backups, checksums and rollback.
5. Review job history, operator, evidence, retries, cost and recovery path.

## Non-functional requirements

Tenant separation at API/worker/database/object storage; TLS verification; secret references; auditable actions; idempotency; bounded retries; pagination; freshness/staleness labels; measured performance; keyboard-accessible dense tables; local/VPS installation; recoverable upgrades and backups.

## Explicit non-goals for initial release

No root-control bypass, arbitrary shared-hosting disk pooling, assumption that cPanel credentials grant WordPress admin, unverified live operations, uncontrolled autonomous runner, unconditional zero downtime, or mobile/desktop-first development.

## Acceptance and status

Use the acceptance gates in Sections 15 and 17 of the master directive. Planned capabilities stay `DESIGNED`; fixtures are `MOCK-TESTED`; actual provider checks require a separately authorized sandbox and are `LIVE-VERIFIED` only with evidence.
