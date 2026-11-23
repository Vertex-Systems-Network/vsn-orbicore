# ORB-005 — scheme-bound Origin gate for local API writes

**Date:** 2026-11-23 UTC. **State:** Functional PR head `e5fbea6f6cabb1f890f6e7addf786024b8b534fc` passed hosted GitHub Actions checks. Documentation-head CI and merge pending. This is local SQLite API hardening only, not production-auth or PostgreSQL-cutover evidence.

## Finding

The existing write/CSRF boundary in `apps/api/server.mjs` compared `new URL(Origin).host` with the effective request Host. An Origin using the **opposite HTTP/HTTPS scheme** but the same host and port could pass. A Host-only comparison is insufficient because scheme is part of the web origin. A serialized Origin with paths or user-info was also not explicitly denied.

## Changes

- Export `isSameOriginRequest(request)` and require the expected scheme, based on direct TLS or the previously allowlisted **loopback-only** forwarded HTTPS signal, plus canonical host/port equality.
- Reject supplied empty, malformed, non-HTTP, cross-scheme, path/query/fragment and credential-bearing Origin values. Keep the existing no-Origin allowance for non-browser clients, and preserve the existing loopback proxy trust boundary.
- Add pure transport/authority regression and a real localhost HTTP bootstrap regression that checks **403 and zero users** on mismatched scheme, followed by successful exact-origin bootstrap.

## Verified GitHub Actions results (functional head)

- [Branch CI #45179432007](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45179432007) and [PR CI #45179442764](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45179442764) **succeeded** at `e5fbea6f`: **162/162 Node tests** passed, zero failures, including both new Origin regressions. `npm ci`, lint/plan, security, npm audit, official offline schema/SBOM, build, smoke and doctor passed.
- [PostgreSQL 16 / Redis 7 service CI #45179442703](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45179442703) **28/28 hosted jobs passed**. [Chromium/WebAuthn/accessibility #45179442776](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45179442776) succeeded, as did [trusted PR ledger #45179438980](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45179438980).
- **Remaining:** final docs-head GitHub CI and post-merge `main` CI confirmation. The first functional head failed one new pure helper assertion due to incorrectly escaped authority-validation regex; the regression caught this, and corrected `e5fbea6f` passed both tests and all gates. No live provider actions occurred.

## Boundaries

No live cPanel account, Redis worker, cross-store migration, identity provider, OAuth/TLS deployment, reverse proxy configuration, permissions, database schema, or production credentials were touched. A request without Origin is still accepted on the prior contract; this is not an anti-CSRF token system. Loopback proxy headers are not cryptographically authenticated; a production reverse proxy needs separately reviewed trust configuration. ORB-005 stays `in_progress/integration_tested` and ORB-017 stays `testing/integration_tested`.
