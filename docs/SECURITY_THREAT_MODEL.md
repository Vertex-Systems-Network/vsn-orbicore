# Security threat model — Phase 0/1 baseline

## Assets and trust boundaries

Assets: hosting credentials/tokens, customer site/database/email data, migration archives, object-store keys, tenant inventory, audit trail, job integrity, DNS authority and AI prompts. Boundaries: browser/API, tenant/API, API/worker queue, worker/provider, worker/object storage, local install/operator secrets, and optional external model provider.

## Threats and required mitigations

| Threat | Initial control / acceptance |
|---|---|
| Cross-tenant data/action | Tenant ID enforced in DB/service/queue/storage; negative tests for every API/job path; never rely on hidden UI controls |
| Credential theft/log leakage | Vault references, TLS, least-privilege token, redaction, rotation/revoke path, secret scans; no token in fixtures, URLs or prompts |
| SSRF/DNS rebinding | Provider-specific allow-list, resolve and pin connection, reject private/link-local/metadata IPs, validate redirects and TLS; test DNS changes |
| Path traversal/command injection | Canonical path containment, argument arrays, no shell interpolation, untrusted filenames; adversarial tests |
| Forged/replayed agent/webhook request | Signed payload, nonce/timestamp, scoped keys, replay store and tenant binding |
| Unauthorized/destructive operation | Policy decision at API and worker immediately before call; dry run, idempotency, backups, approvals, audit and emergency stop |
| Backup corruption/exposure | Encryption, immutable/versioned storage when supported, checksums, retention, restore drill and scoped signed URLs |
| Malicious provider output / AI prompt injection | Treat response/content as data, schema validate, redact, do not execute embedded instructions; deterministic policy engine authorizes actions |
| Dependency or license risk | Lockfile, pinned runtime, dependency/SBOM and license scanning in CI |

## Implemented local prototype controls

- One-time bootstrap token file is created with mode `0600`; only its digest is stored in SQLite and it is consumed after the first owner is created.
- Passwords use salted `scrypt` hashes. Random session tokens are stored by hash, cookies are `HttpOnly`/`SameSite=Strict`, sessions expire after 12 hours, and logout/disabled-user checks revoke access.
- The local SQLite schema scopes accounts and jobs to an organization. API reads, site lookups, job lookups, audit reads and refresh requests include that scope. The worker rechecks the requesting actor's active state, organization and role.
- Cookie-authenticated writes enforce same-origin and the API limits failed login/bootstrap attempts per client IP in the current process.
- Owner/admin can query their own bootstrap and refresh audit records; the test verifies cross-tenant isolation and checks bootstrap credentials do not appear in events. This local log is not tamper-evident.
- Executed negative checks cover anonymous access, cross-tenant reads/actions, audit isolation, viewer-role restrictions, worker policy rechecks, session expiry/logout, cross-origin writes and login throttling. Evidence: `tests/inventory-api.test.mjs` and `docs/TEST_EVIDENCE/2026-11-09-local-poc.md`.

## Current blockers

The local proof still lacks MFA/recovery, SSO, a vault, provider egress control, distributed rate limiting, production TLS/proxy guarantees and real audit integrity. It is loopback-only and synthetic-data-only. Do not add real hosting secrets/data or expose it as a production service. Remaining security work is tracked in ORB-005 and ORB-010.
