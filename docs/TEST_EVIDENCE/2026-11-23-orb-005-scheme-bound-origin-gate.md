# ORB-005 — scheme-bound Origin gate for local API writes

**Date:** 2026-11-23 UTC. **State:** Implementation on feature branch; hosted GitHub Actions verification pending. This is local SQLite API hardening only, not production-auth or PostgreSQL-cutover evidence.

## Finding

The existing write/CSRF boundary in `apps/api/server.mjs` compared `new URL(Origin).host` with the effective request Host. An Origin using the **opposite HTTP/HTTPS scheme** but the same host and port could pass. A Host-only comparison is insufficient because scheme is part of the web origin. A serialized Origin with paths or user-info was also not explicitly denied.

## Changes

- Export `isSameOriginRequest(request)` and require the expected scheme, based on direct TLS or the previously allowlisted **loopback-only** forwarded HTTPS signal, plus canonical host/port equality.
- Reject supplied empty, malformed, non-HTTP, cross-scheme, path/query/fragment and credential-bearing Origin values. Keep the existing no-Origin allowance for non-browser clients, and preserve the existing loopback proxy trust boundary.
- Add pure transport/authority regression and a real localhost HTTP bootstrap regression that checks **403 and zero users** on mismatched scheme, followed by successful exact-origin bootstrap.

## Verification checklist (pending until GitHub Actions completes)

- `npm ci`, `npm test` (at least the two new tests), `npm run lint`, `npm run security:check`, npm audit, SBOM official offline schema, `npm run build`, `npm run smoke`, `npm run doctor`.
- Existing hosted PostgreSQL 16/Redis 7 service jobs and Chromium/WebAuthn/browser suite after the API change; trusted PR task ledger.
- Final PR head SHA, relevant workflow URLs and conclusions, and post-merge `main` CI.

## Boundaries

No live cPanel account, Redis worker, cross-store migration, identity provider, OAuth/TLS deployment, reverse proxy configuration, permissions, database schema, or production credentials were touched. A request without Origin is still accepted on the prior contract; this is not an anti-CSRF token system. Loopback proxy headers are not cryptographically authenticated; a production reverse proxy needs separately reviewed trust configuration. ORB-005 stays `in_progress/integration_tested` and ORB-017 stays `testing/integration_tested`.
