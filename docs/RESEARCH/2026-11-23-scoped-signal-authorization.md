# Restricted PostgreSQL 16 synthetic poison-signal recorder

**Date:** 2026-11-23. **Scope:** CI-only worker rejection suboperation, not production database auth.

## PostgreSQL official references

- [CREATE FUNCTION — SECURITY DEFINER](https://www.postgresql.org/docs/16/sql-createfunction.html) requires a trusted function owner, secure `search_path`, and revoking default PUBLIC function EXECUTE rights before exposure.
- [Session/user identities](https://www.postgresql.org/docs/16/functions-info.html) distinguish `session_user` (authenticated login) and `current_user` (effective SQL role), which differs during `SET ROLE` and within a security-definer function.
- [SET ROLE](https://www.postgresql.org/docs/16/sql-set-role.html) updates the effective role without turning the authenticated login into another principal.
- [GRANT](https://www.postgresql.org/docs/16/sql-grant.html) defines membership and FUNCTION EXECUTE rights. [Privileges](https://www.postgresql.org/docs/16/ddl-priv.html) explain why default PUBLIC EXECUTE must be removed in the same transaction.
- [Schemas/search path](https://www.postgresql.org/docs/16/ddl-schemas.html) warns against resolving objects from attacker-writable schemas inside privileged functions.

## Trust boundary

A privileged CI migration adds a NOLOGIN/NOINHERIT/NOBYPASSRLS function-execution role. It does **not** let the caller select its own tenant using a custom SQL GUC or arbitrary actor ID. Instead the strict, SECURITY DEFINER fixed-search-path SQL validates `session_user` against an admin-managed login-name→tenant mapping and returns only a Boolean accepted status or allowlisted metadata-only inspection. The PG role cannot read/update the mapping, job/user identity or rejection table directly. Two separately authenticated non-superuser logins are exercised in a hosted PostgreSQL 16/Redis 7 fixture; their passwords are random, generated and used only within that ephemeral job, never uploaded or committed. A revoked EXECUTE privilege blocks signal persistence; the consumer deliberately preserves the Redis pending entry until permission returns.

This does **not** complete restricted worker runtime, secure broker publishing or production credential lifecycle; general synthetic worker operations still use the existing privileged fixture pool. `session_user` does not independently prove the real application user or authorized provider action. External immutable storage, operator IAM, real authorization, queues/jobs and production cutover remain separate gates.
