# Deployment matrix (initial assumptions)

| Mode | Runtime shape | Data/queue | Status | Limits |
|---|---|---|---|---|
| Developer laptop | Node 24+ web/API; local SQLite for current PoC | SQLite job rows; one local worker | Implemented only as local slice | Experimental Node SQLite API if selected; no tenant/auth or multi-node guarantees |
| Single VPS self-hosted | Reverse proxy + TLS, web/API, worker, PostgreSQL, Redis, encrypted backups | PostgreSQL + BullMQ/Redis; S3-compatible backup optional | Designed | Minimum CPU/RAM/storage not measured; do not publish hardware promises yet |
| Managed/container | Docker Compose or equivalent with separate data persistence and secrets | Managed PostgreSQL/Redis/object storage | Candidate only | Provider-specific health, backup and egress costs need validation |
| Shared cPanel account | Not a target for central control-plane runtime | N/A | Unsupported as assumed deployment | Restrictive shared hosting may not run required Node/database/worker stack |
| Desktop/mobile | Thin clients on stable authenticated API | Shared API and policies | Deferred | No scaffold until web contract stabilizes |

All environment resource values remain `unknown` until measured against a documented fixture load and modest VPS. External provider access and cloud costs are not estimated as facts.
