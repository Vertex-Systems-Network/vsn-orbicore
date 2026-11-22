# PostgreSQL 16 separate-cluster restore and AES-GCM fixture envelope

**Date:** 2026-11-23. **Context:** ORB-016/017 CI-only separate Docker cluster regression; see [hosted evidence](../TEST_EVIDENCE/2026-11-23-orb-016-isolated-encrypted-restore.md).

## Official references

- [PostgreSQL 16 pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html) documents custom-format database archives and their limitations.
- [PostgreSQL 16 pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html) documents transactional restore, owner and grant replay behavior and errors.
- [PostgreSQL 16 pg_dumpall](https://www.postgresql.org/docs/16/app-pg-dumpall.html) documents `--globals-only` to capture the cluster role definitions that a per-database archive does not preserve; `--no-role-passwords` deliberately avoids exporting role verifier hashes.
- [PostgreSQL 16 SQL dump and recovery](https://www.postgresql.org/docs/16/backup-dump.html) distinguishes database-only and whole-cluster state.
- [Node.js 24 authenticated encryption](https://nodejs.org/download/release/v24.22.1/docs/api/crypto.html) explains AES-GCM authentication tag handling; decryption must discard plaintext when verification fails and validate explicit tag length.

## Decision / exclusions

The next unblocked development step after the same-cluster PR #32 was a **different PostgreSQL 16 cluster**, with global role recreation and real RLS/column-grant tests rather than only catalog flags. In the CI fixture the source uses service port 5432 and the target a standalone Docker PostgreSQL 16 instance on port 5433 with independent PGDATA, role catalog and bootstrap user. The source roles are exported explicitly, without password hashes, and the data archive retains ownership/ACL statements. Both files have an AES-256-GCM envelope with a fresh IV, 128-bit tag, distinct authenticated contexts and random fixture-only key. Wrong-key/ciphertext/tag checks fail before destination-file creation. The fixture limit is 64 MiB per archive.

**Not a production backup design:** moving ciphertext between two databases on the same runner is not offsite retention, and generating a throwaway key without external secure custody cannot provide operational recovery. Production needs independently administered encrypted object storage with immutable retention, KMS/HSM policy and restore access, verified cluster roles, full app/queue/MFA key restore, RTO/RPO testing, approved cutover and manual disaster-recovery runbook. No production PostgreSQL auth authority was enabled.
