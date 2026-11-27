# ORB-002/004 — mock inventory source boundary

Date: 2026-11-27 UTC. Base: main acea1b3c46adbd2fafafae79e5dd16f5da942247 (PR #85 merged). Hosted verification pending.

A provider-tagged account with an ID matching a known fixture could previously be refreshed by the mock worker and relabeled as a mock fixture. The refresh route also queued mock jobs without checking the persisted source.

- Reject provider-tagged accounts with HTTP 409 provider_refresh_not_enabled before mock enqueue (including the test-only PostgreSQL injection route); recheck the local SQLite source under the enqueue writer lock.
- Worker refuses all provider-tagged accounts, even if a fixture ID matches. Completion updates only a still-mock account under the existing transaction and never rewrites its source.
- Two HTTP/worker regressions assert zero queued jobs and audit changes when initially denied; and a failed queued job without account provenance or timestamp mutation when the source changes after enqueue.

No live provider activation, external calls, schema migration, or production distributed-worker parity claim. The injected PostgreSQL path still has its existing cross-store boundary. ORB-002 testing/mock_tested and ORB-004 testing/integration_tested remain unchanged; ORB-006/019 remain blocked.

## Hosted PR #86 functional-head evidence

GitHub Actions on `02e376c2750d56796035d264b9f1a13c0dbb946c` (2026-11-27 UTC):

- [Standard CI #46024364880](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46024364880) and [push CI #46024331999](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46024331999) passed. PR job log records 208/208 Node tests, zero failures/skips/cancellations, including both new source-boundary tests. Lint, plan alignment, security, SBOM/CycloneDX, dependency audit, build, smoke and doctor succeeded.
- [Service integration #46024364923](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46024364923): 28/28 disposable PostgreSQL/Redis jobs succeeded.
- [Browser #46024364925](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46024364925): Chromium, Firefox and WebKit 3/3 succeeded.
- [Trusted ledger #46024364981](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46024364981): succeeded; 20 tasks, 6 verified, 9 testing, 3 in progress, 2 blocked.

Final evidence-only head verification and merge pending. No live provider, production distributed-worker or cross-store atomicity proof; lifecycle and verification levels unchanged.
