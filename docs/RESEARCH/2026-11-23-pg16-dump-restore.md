# PostgreSQL 16 recovery drill design — 2026-11-23

Official PostgreSQL 16 documentation:
- [pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html) explains custom-format archives and schema/data backups.
- [pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html) describes `--single-transaction`, `--exit-on-error`, `--no-owner`, and `--no-acl` behavior.
- [SQL dump and restore](https://www.postgresql.org/docs/16/backup-dump.html) shows how a custom archive is transported and restored.
- [pg_dumpall](https://www.postgresql.org/docs/16/app-pg-dumpall.html) is relevant to global objects such as roles that per-database `pg_dump` does not carry.

This slice uses a real PostgreSQL 16 database snapshot and restoration into a second database **on the same service host**. This is stronger than a metadata-only proof but far weaker than independent disaster recovery: role memberships, permissions, server-level configuration, WAL/PITR, object-store immutability, encrypted credentials, retained keys, session continuity, and separate-node recovery are intentionally not asserted.

A mismatch between the GitHub runner's default `pg_dump` and PostgreSQL 16 caused the first hosted test to fail. The accepted implementation pins the exact PostgreSQL 16 client by invoking `pg_dump`/`pg_restore` through `postgres:16-alpine` Docker, the same major version as the disposable service. It transmits **no** production credentials, uploads **no** database archive and verifies schema/RLS metadata and synthetic data parity plus negative corruption/drift probes. The method does not constitute a verified full backup of a production installation.

Next: separately administered, encrypted off-host backup with keys, PG cluster-global roles/privileges, real restore on an independently provisioned cluster, and a signed/approved rollback runbook. Do not elevate PostgreSQL authentication authority based on this fixture.
