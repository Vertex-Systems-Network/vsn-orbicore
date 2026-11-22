# ORB-005 — PostgreSQL 16 private shadow fixture research — 2026-11-22

**Official reference:** [PostgreSQL 16 row-security policies](https://www.postgresql.org/docs/16/ddl-rowsecurity.html) and [ALTER TABLE FORCE ROW LEVEL SECURITY](https://www.postgresql.org/docs/16/sql-altertable.html).

PostgreSQL 16 uses **default-deny** for an RLS-enabled table without applicable policies. Roles granted table privileges cannot read or modify rows absent an authorizing policy. Table owners normally bypass RLS unless `FORCE ROW LEVEL SECURITY` is set; superusers and `BYPASSRLS` roles still bypass it. RLS is not a substitute for private schemas, explicit revocation, non-owner role checks or privileged SQL governance.

For ORB-005 Slice B, use an explicitly gated disposable CI fixture only. Place synthetic placeholder rows in a separate schema with no PUBLIC privileges, deny all direct table access to existing runtime/read-only roles, apply FORCE RLS with no policies, and prove a real NOINHERIT/NOBYPASSRLS LOGIN remains denied even after deliberately granting table privileges for a negative test. The CI schema is not a production credential table, does not hold real password verifiers and does not authenticate any user.

**Unverified:** production schema owner privileges, trusted SECURITY DEFINER writers, new password KDF selection, secret custody, idempotent cross-store writes, tenant-sensitive reauthentication, off-host backup/restore and reversible authority cutover. No real provider authorization is implied.
