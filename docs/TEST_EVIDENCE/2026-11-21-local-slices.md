# Test Evidence — Local Vertical Slices & Security Gates (2026-11-21)

- **Environment:** Node `v22.23.2` (built-in `node:sqlite`), Vite `7.3.8`, TypeScript `5.9`, local container without Docker/PostgreSQL/Redis daemons or headless Chromium binary.
- **Commands executed & observed outcomes:**
  - `npm test`: **42 / 42 passed** (`tests/inventory-api.test.mjs`, `tests/knowledge-bank.test.mjs`, `tests/mfa.test.mjs`, `tests/platform-slices.test.mjs`, `tests/security.test.mjs`).
  - `npm run security:check`: **Passed** (`secretFindings: []`, `disallowedLicenses: []`, CycloneDX SBOM component count `10`).
  - `npm run lint`: **Passed** (`tsc --noEmit`, `check-json.mjs`, `validate-banks.mjs` — records validated).
  - `npm run build`: **Passed**.
  - `npm run smoke`: **Passed** (Vite proxy + SQLite bootstrap + synthetic inventory + worker refresh job).
  - `npm run doctor`: **Passed** (`supportedNode: true`, `sqliteApi: true`, `postgres: not detected`, `redis: not detected`, `liveProviderConnections: 0`).

## Covered Capabilities (Local / Mock Mode Only)

1. **Identity, MFA & Passkey Negative Boundaries (`ORB-011`, `ORB-012`, `ORB-013`, `ORB-014`)**:
   - Versioned AES-256-GCM MFA keyring rotation (`k1 -> k2`) preserving TOTP login validity.
   - Non-destructive SQLite backup creation + `restore-drill` verifying schema, user/account/site counts, and MFA seed decryptability while rejecting path traversal (`../../etc/passwd`) and failing closed on corrupted SQLite files (`corrupt_sqlite_database`).
   - Legacy pre-v5 SQLite database upgrade (`INSTALL-UPGRADE-001`) cleanly migrating to v7 while preserving existing user data.
   - Verified recovery contact flow, local outbox notification adapter (`notifications.mjs`), transient failure -> `retry_pending` -> manual retry recovery.
   - HTTP-level `passkeys/login/verify` & `passkeys/register/verify` rejections for wrong origins, consumed replay handles, and expired challenges.
2. **Security, Secret References & Audit Integrity (`ORB-015`, `ORB-017`, `KI-001`)**:
   - SSRF validator blocking loopback, RFC1918 private, link-local metadata (`169.254.169.254`), and IPv4-mapped IPv6 addresses.
   - Canonical path containment preventing traversal/prefix escapes; nested secret redaction across logs/diagnostics.
   - Encrypted secret references registry (`v7` schema `secret_references`, PostgreSQL parity table, `/api/secrets`, `/api/secrets/:id/revoke`) with AES-256-GCM envelope encryption failing closed (`503`) without master key, masking API listings (`••••suffix`), and purging ciphertext upon owner revocation.
   - Production deployment readiness wizard (`GET /api/system/deployment-readiness`) separating `local_sqlite_prototype` from `production_ready` gates (PostgreSQL, Redis, KMS, TLS/Secure cookies, SMTP).
   - Append-only SHA-256 audit hash chain (`prev_hash` / `entry_hash`) with `/api/audit/verify` detecting direct SQLite row tampering.
   - Negative injection assertions (`SEC-INJECTION-001`) verifying SQL, shell, and script payloads cannot bypass auth or mutate parameterized SQLite state.
   - Static secret scan, OSS license allowlist enforcement, and CycloneDX component summary via `scripts/security-gate.mjs`.
3. **Control-Plane Vertical Slices, Demo Dataset & UX Parity (Phases 2–8, Synthetic / Dry-Run)**:
   - Pre-seeded realistic demo workflows (2 migration plans, 2 offload policies, 2 verified snapshots, 2 WordPress states, 2 automation rules) + idempotent `POST /api/system/demo-seed` for extended dummy accounts/sites/team/activity (`liveConnections: 0`).
   - Startup worker crash recovery automatically requeuing interrupted `running` jobs (`recovered_after_restart`) with chained audit events.
   - Light/Dark contrast-parity theme toggle (`localStorage`-persisted `data-theme`) and keyboard-accessible column sorting on `WebsitesView`.
   - Mock cPanel adapter + read-only HTTPS UAPI client boundary (`LiveCpanelAdapterBoundary` tested with injected mock transport for UAPI `domains_data`, 401/403 revoked token handling, and SSRF guard; `POST /api/accounts/cpanel/probe`).
   - Migration dry-run state machine with 30% transfer failure simulation, idempotent checkpoint resume, explicit `confirmCutover: true` gate, and rollback.
   - Storage offload policy planner with outage fail-closed (`paused`) & rehydration checksum drills.
   - WordPress dry-run staging clone, pre-update restore snapshot, and rollback lifecycle (`wp_site_state` schema parity).
   - Deterministic telemetry advisor (`GET /api/automation/insights`), RBAC/cap-limited automation rules (`429 budget_capped`), and agency readiness portfolio JSON + CSV audit exports.

## Known Limitations (Unverified in This Environment)

- `liveProviderConnections: 0`: No owner-authorized live cPanel/WHM account or external S3 bucket exercised.
- PostgreSQL 16 & Redis 7 Compose/DDL (`.github/workflows/ci-services.yml`, `docker-compose.yml`, `db/postgres-schema.sql`) have not been executed locally because Docker/PostgreSQL/Redis binaries are unavailable in this runtime.
- Full browser DOM rendering, screen-reader accessibility checks, and CDP virtual-authenticator WebAuthn E2E (`.github/workflows/ci-browser.yml`, `scripts/browser-verify.mjs`) await a GitHub-hosted Chromium runner.
