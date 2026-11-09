# Security threat model — Phase 0 baseline

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

## Current blockers

The local proof has no authentication, tenant authorization, vault, provider egress control or real audit integrity. Do not put real hosting secrets/data into it or expose it as a production service. Threat-based verification is backlog ORB-005 and ORB-010.
