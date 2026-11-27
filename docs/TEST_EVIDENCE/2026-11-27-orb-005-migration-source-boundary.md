# ORB-005/009 — synthetic migration provenance boundary

Date: 2026-11-27 UTC. Base main 7a4db28e923d4c8fad419af2cbea1e876adb6633 (PR #89 merged). Hosted verification pending.

Local migration planning and advance previously inferred quota and capability support from account profiles regardless of source. Require both source site/account and target account to belong to the tenant and remain mock fixtures before plan creation or forward advancement, including simulated partial failure. Recheck under the SQLite writer lock before writes. Return 409 provider_migration_not_enabled on denial without mutating plans or audit. Local rollback remains a local state-only cancellation; no provider operation is performed.

The UI limits source/destination selection to mock records and disables advancement when either persisted account is ineligible; server checks remain authoritative. Regression exercises both provenance directions for creation and transfer advancement, including simulated failure; verifies unchanged rows and allowed local rollback.

No live migration, DNS, storage or production permission proof. Existing browser suite pending; no dedicated new migration UI browser assertion. Task lifecycle and verification levels unchanged.
