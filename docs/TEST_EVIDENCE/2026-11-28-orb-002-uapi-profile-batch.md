# ORB-002 — UAPI response and capability profile validation batch

Base main 0eb4a25b1d3629074504537967dcf08faa17bc6d; PR #95 final standard, service, browser and ledger checks passed before merge. Hosted verification pending.

Two independent commits reject non-array/non-null UAPI error metadata even with numeric success status; preserve omitted/null/empty-array error compatibility; test direct and wrapped capability, inventory and health responses without network calls. Validate profile names against own properties only, reject explicitly invalid sandbox inputs before writes, preserve documented default for omitted input and mock adapter fallback. Persisted unknown profile fallback for account capability retrieval is empty; migration permission checks fail closed. Existing mock adapter fallback remains synthetic only.

No live provider credentials, DNS transport changes, production grant or lifecycle promotion. GitHub-only validation applies. 

## Hosted PR #96 functional-head verification

At `76c0e26f95802e9cc40390c24ef77186e04e179f` (2026-11-28 UTC), [standard CI #46090043962](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46090043962) passed all 220 Node tests with no failures, skips or cancellations. Logs confirm all three new regressions: malformed UAPI metadata denial, inherited profile property rejection, and sandbox invalid profile denial without writes. Plan alignment passed. [Service integration #46090043976](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46090043976) passed 28/28 disposable PG/Redis jobs; [browser #46090043984](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46090043984) passed all three existing browser jobs; [trusted ledger #46090043782](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46090043782) passed. Prior PR #95 post-merge [main CI #46089938795](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46089938795) passed. No live provider evidence or task promotion; final evidence-head verification/merge pending.
