# ORB-005 — CI-only PostgreSQL shadow storage access-denial proof — 2026-11-22

## Hosted results

- [PR #24](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/24), tested functional SHA `f41f78c509d76bff1643eeb3c44c2f887f007b83`.
- [Hosted Service Integration #45055972375](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45055972375) **success across all 10 jobs**, including **Disposable PostgreSQL 16 private shadow fixture and non-owner denial**. The other nine PostgreSQL, Redis, and Compose regression jobs were green at the same head.
- [PR standard CI #45055972363](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45055972363) and [branch standard CI #45055953186](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45055953186) **success** at the same functional SHA, including `npm ci`, `npm test`, `npm run lint`, `npm run security:check`, SBOM generation/upload, `npm audit --audit-level=high`, `npm run build`, `npm run smoke` and `npm run doctor`.
- [Raw machine-readable CI artifact #14766933040](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45055972375/artifacts/14766933040), `orb-005-postgres-ci-shadow-schema`; GitHub-reported ZIP digest `sha256:caaf725921e5fe30497eac0ac3ad1a79f747c7d1f7de9513543de4301aa8e326`. The artifact reports no real credential use.
- GitHub-hosted Ubuntu, Node 24, PostgreSQL 16 service. Workflow applies `db/postgres-schema.sql`, migrations `001`–`006`, followed by `010` **twice** under `PGOPTIONS="-c orbicore.ci_shadow_fixture=enabled"` and `ORBICORE_CI_SYNTHETIC_SHADOW_SCHEMA=1`. Runs `node scripts/verify-postgres-ci-shadow-schema.mjs > .data/ci/orb-005-ci-shadow-schema.json`.
- This evidence file is a later documentation update. The final PR docs head and post-merge `main` CI must be verified independently; the functional result above is tied to the exact older tested SHA.

## What was actually verified

1. Migration `010_postgres_ci_shadow_schema.sql` is **CI-only**, aborts without explicit configuration, and is rerunnable. It creates a private schema and a restricted `NOLOGIN NOINHERIT NOBYPASSRLS` role without any table or schema access. The table accepts only marked **fake CI placeholder material**, not a real password verifier.
2. The table has organization/user composite foreign keys, positive epochs, bounded versioned fixture values, state enumeration, tenant-scoped unique idempotency keys and a single pending synthetic draft per user. Wrong-tenant IDs, malformed placeholders, duplicate epoch and multiple pending drafts are rejected. Forced failure inside a transaction leaves no partially committed draft.
3. Existing tenant read-only, job submitter and new shadow-stager roles have no schema/table grants. A freshly created actual PostgreSQL non-superuser, `NOINHERIT NOBYPASSRLS` LOGIN cannot select verifier/digest material or insert a draft, even via `SET LOCAL ROLE`.
4. The fixture table uses `ENABLE ROW LEVEL SECURITY` plus `FORCE ROW LEVEL SECURITY` with **zero permissive policies**. After a test-only direct grant of table/schema privileges, the non-owner still reads zero rows, cannot insert, cannot delete a row, and cannot bypass the policy using `row_security=off`. Temporary privileges are revoked after the negative proof.
5. No password, cookie, live provider token, production verifier, real tenant, or user account was imported. Normal `apps/api/server.mjs` SQLite authentication was not modified; the previous CI-only PostgreSQL bcrypt login still has no connection to this shadow fixture.

## Security and completeness limitations

- PostgreSQL RLS bypass by superusers/`BYPASSRLS` roles remains possible by design; the ephemeral schema-owner CI account is a privileged test operator, not a production role model. Verify real production role provisioning, schema ownership, grants and migrations separately.
- The `PGOPTIONS` opt-in is an **accidental-use guard only**, not an authorization control: SQL execution still depends on operator permissions. No shadow writer or read-verifier function is granted, no real password KDF selected, no reauthentication endpoint added, and no account authority switched.
- The fixture table stores fake marker-constrained values; it is **not** a vetted production password store. This test does not establish production secret custody, encrypter key provenance, Unicode password normalization policy, real tenant mapping, credential epochs across SQLite and PostgreSQL, distributed login throttling, MFA/passkey continuity, authenticated audit-chain parity, off-host recovery or rollback.
- No evidence of real provider operations, live credentials, physical authenticator use, production TLS cookies or complete SQLite-v7 jobs/secrets/audit migration. ORB-005 remains `in_progress / integration_tested`.

## Next implementation gate

Design a separate, explicitly **CI-only**, source-authenticated reauthentication test where SQLite stays authoritative, with a reviewed destination KDF, per-user epoch fencing, trusted role-limited shadow writes and forced PG outage/partial-rollback cases. Do not connect normal login, store real verifiers or promote PostgreSQL to an authentication authority until comprehensive security/recovery gates in ADR-0003 pass.
