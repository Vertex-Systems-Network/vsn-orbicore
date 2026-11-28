# ORB-004/005 — PostgreSQL job requester idempotency parity

Original draft base 1912b5006dc6bf7edd8298227ef10d932974b0c6; reconciled on main b4dbd0f49dd77f8bac846790f85fe12f9efefd19 after PR #94 merged. Hosted verification pending.

Bind existing PostgreSQL queue idempotency replay to original requester, account and job type, including null requester semantics. Preserve same-requester retry and tenant namespace. The explicit test-only HTTP bridge must map cross-requester replay to 409. Verify no duplicate job or transactional outbox intent and rollback/release on conflict. Unit tests and real disposable PostgreSQL/Redis verification scripts extended. No change to default SQLite authority, production worker or restricted SQL gateway. No local execution under AGENTS.md.

Canonical task records reconciled with main; hosted verification required.

## Independent terminal-history validator hardening

The shared offline CI-only terminal history helper now directly requires mock account provenance, strict string identifiers and unique persisted job IDs/idempotency keys across the candidate rows before any insert. The outer importer already checks source provenance; this is defense in depth, not a new production migration capability. Unit regression confirms provider/unknown source, numeric identifiers and duplicates are denied before database writes. Historical fixture key representation is preserved unchanged.
