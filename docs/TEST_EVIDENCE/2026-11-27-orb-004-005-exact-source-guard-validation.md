# ORB-004/005 — exact persisted SQLite source guard validation

Date: 2026-11-27 UTC. Status: branch implementation; GitHub Actions results pending.

Base: main 5444dd38e800c40cdcb3bf785590804df64a93ce, merged PR #81. Previous functional head 668bed72 passed 197 Node tests, 28 service jobs, 3 browser jobs and ledger; these results do not verify this change.

## Change and regression plan

- Match the complete expected generated SQLite trigger definition, allowing only the optional stored CREATE TRIGGER IF NOT EXISTS prefix normalization. Reject mismatches in timing, operation, predicate or body. Use case-insensitive lookup for SQLite trigger identifiers to detect name collisions.
- File-backed regression cases change the predicate and operation independently while retaining the old required fragments; restart must refuse, preserving account and migration counts. Another test covers a differently cased same-name trigger. Existing stable restart tests check legitimate definitions remain reusable.
- Official source and rationale: [SQLite schema trigger validation](../RESEARCH/2026-11-27-sqlite-schema-trigger-validation.md).

Verification: standard Node/lint/security/build/smoke, applicable hosted services/browser and ledger checks pending. No pass claim until measured head results are recorded.

Limitations: strict generator-defined format deliberately denies semantically equivalent but manually rewritten definitions; investigate rather than silently rewrite. Not a DDL, privileged-file, WORM, distributed PG/Redis, provider or production cutover boundary. ORB-004 testing/integration_tested and ORB-005 in_progress/integration_tested remain unchanged.

## Hosted PR #82 functional-head evidence

GitHub Actions on `27344408334fdbb4274421f75628874fa6c81cdb` (2026-11-27 UTC):

- [Standard CI #45996488064](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45996488064): 199/199 Node tests passed, zero failures/skips; both new tests passed. Lint, plan alignment, security, CycloneDX/SBOM, npm audit, build, smoke and doctor passed.
- [Service integration #45996488345](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45996488345): all 28 disposable PG16/Redis7/Compose jobs succeeded.
- [Browser #45996488044](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45996488044): Chromium, Firefox, WebKit 3/3 succeeded.
- [Trusted PR ledger #45996488110](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45996488110): succeeded; 20 tasks, 6 verified, 9 testing, 3 in progress, 2 blocked.

The functional SHA is verified for this scoped regression. Final evidence-only PR head checks and merge are pending at the time of this update. No lifecycle promotion or production claim.
