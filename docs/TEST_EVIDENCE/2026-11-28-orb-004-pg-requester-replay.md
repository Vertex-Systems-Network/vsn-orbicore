# ORB-004/005 — PostgreSQL job requester idempotency parity

Original draft base 1912b5006dc6bf7edd8298227ef10d932974b0c6; reconciled on main b4dbd0f49dd77f8bac846790f85fe12f9efefd19 after PR #94 merged. Hosted verification pending.

Bind existing PostgreSQL queue idempotency replay to original requester, account and job type, including null requester semantics. Preserve same-requester retry and tenant namespace. The explicit test-only HTTP bridge must map cross-requester replay to 409. Verify no duplicate job or transactional outbox intent and rollback/release on conflict. Unit tests and real disposable PostgreSQL/Redis verification scripts extended. No change to default SQLite authority, production worker or restricted SQL gateway. No local execution under AGENTS.md.

Canonical task records reconciled with main; hosted verification required.

## Independent terminal-history validator hardening

The shared offline CI-only terminal history helper now directly requires mock account provenance, strict string identifiers and unique persisted job IDs/idempotency keys across the candidate rows before any insert. The outer importer already checks source provenance; this is defense in depth, not a new production migration capability. Unit regression confirms provider/unknown source, numeric identifiers and duplicates are denied before database writes. Historical fixture key representation is preserved unchanged.

## Hosted PR #95 functional-head verification

GitHub Actions on `987da69f5f00d6bc95b7a2305a76200fa0e1966b` (2026-11-28 UTC): [standard CI #46089603771](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46089603771) passed 217/217 Node tests (zero failures, cancellations or skips), including the requester replay, outbox rollback and terminal history validation regressions. Plan alignment passed. [Service integration #46089603809](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46089603809) passed all 28 disposable PostgreSQL/Redis jobs, including the updated HTTP bridge and outbox verification scripts (parity job 140807165274) and terminal history atomic rollback job 140807165714. [Browser #46089603751](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46089603751) passed all three existing engine jobs. [Trusted ledger #46089604196](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46089604196) passed. Prior PR #94 post-merge [main CI #46089459720](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46089459720) passed.

No local execution, production authority change, full database cutover, or live provider proof. Three distinct commits were published with one coordinated ref update; final evidence-only head verification and merge pending. Task lifecycle unchanged.
