# Test strategy

## Test pyramid

1. Static checks: TypeScript strict mode, formatting/lint, JSON schema validation, secret scan.
2. Unit: adapter normalization, capability mapping, policy rules, path/URL guards, job state transitions.
3. Contract: API request/response schemas, UAPI fixture versions, error mapping, migration state schema.
4. Integration: temporary local database, durable job restart/retry/idempotency, mocked UAPI/DNS/S3/WP/IMAP.
5. Browser/UI: major flows, loading/error/empty/permission states, accessible keyboard interaction, screenshot review.
6. Live sandbox: only specifically authorized disposable accounts; least-privilege and negative permission tests; never use production by inference.
7. Release: performance/resource baselines, tenant isolation, security scans, restore/rollback drill and installation upgrade.

## Current evidence rule

The initial fixture-backed API/UI and local persistence are mock/local tests only. Without PostgreSQL/Redis services and provider sandbox, mark those gates blocked; don't convert environment absence into a passing test. Record command, runtime version, duration, exit code, exact fixture and relevant artifacts in `docs/TEST_EVIDENCE/`.

## MFA increment

`tests/mfa.test.mjs` covers the RFC 6238 TOTP vector and replay rejection, encrypted-seed integrity, owner enrollment, password-plus-MFA login, single-use recovery codes, session revocation, audit/outbox effects and key-unavailable denial. These are deterministic local tests, not WebAuthn or browser tests. WebAuthn origin/RP validation and credential replay, verified-contact delivery, key rotation/recovery, deployment hardening and browser accessibility are separate unverified gates.
