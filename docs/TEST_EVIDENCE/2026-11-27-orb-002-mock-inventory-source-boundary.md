# ORB-002/004 — mock inventory source boundary

Date: 2026-11-27 UTC. Base: main acea1b3c46adbd2fafafae79e5dd16f5da942247 (PR #85 merged). Hosted verification pending.

A provider-tagged account with an ID matching a known fixture could previously be refreshed by the mock worker and relabeled as a mock fixture. The refresh route also queued mock jobs without checking the persisted source.

- Reject provider-tagged accounts with HTTP 409 provider_refresh_not_enabled before mock enqueue (including the test-only PostgreSQL injection route); recheck the local SQLite source under the enqueue writer lock.
- Worker refuses all provider-tagged accounts, even if a fixture ID matches. Completion updates only a still-mock account under the existing transaction and never rewrites its source.
- Two HTTP/worker regressions assert zero queued jobs and audit changes when initially denied; and a failed queued job without account provenance or timestamp mutation when the source changes after enqueue.

No live provider activation, external calls, schema migration, or production distributed-worker parity claim. The injected PostgreSQL path still has its existing cross-store boundary. ORB-002 testing/mock_tested and ORB-004 testing/integration_tested remain unchanged; ORB-006/019 remain blocked.
