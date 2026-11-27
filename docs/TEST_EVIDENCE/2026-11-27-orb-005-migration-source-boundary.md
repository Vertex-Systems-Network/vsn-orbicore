# ORB-005/009 — synthetic migration provenance boundary

Date: 2026-11-27 UTC. Base main 7a4db28e923d4c8fad419af2cbea1e876adb6633 (PR #89 merged). Hosted verification pending.

Local migration planning and advance previously inferred quota and capability support from account profiles regardless of source. Require both source site/account and target account to belong to the tenant and remain mock fixtures before plan creation or forward advancement, including simulated partial failure. Recheck under the SQLite writer lock before writes. Return 409 provider_migration_not_enabled on denial without mutating plans or audit. Local rollback remains a local state-only cancellation; no provider operation is performed.

The UI limits source/destination selection to mock records and disables advancement when either persisted account is ineligible; server checks remain authoritative. Regression exercises both provenance directions for creation and transfer advancement, including simulated failure; verifies unchanged rows and allowed local rollback.

No live migration, DNS, storage or production permission proof. Existing browser suite pending; no dedicated new migration UI browser assertion. Task lifecycle and verification levels unchanged.

## Hosted PR #90 verification and merge

Functional SHA `b339c0cb480356fc458293a3f83c0c637af56cc4`: [push CI](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46079676340) and [PR CI](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46079691832) passed (211/211 Node tests in push log, including migration provenance regression); [service integration](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46079691873) 28/28; [browser](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46079691817) 3/3; [trusted ledger](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46079691583) passed. PR #90 merged externally by repository account wpessential at 2026-11-27T22:59:26Z as `5fbe9da66381bd49c932efe8f38fafa683e26e91`. Post-merge [main CI](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46079877896) was in progress when checked. No dedicated migration UI browser proof or live operation.
