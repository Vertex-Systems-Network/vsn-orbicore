# ORB-002/009 — mock-only inventory refresh controls

Date: 2026-11-27 UTC. Base main e66aa9ca520be9fc071f1d2e7783442a4055551b (PR #86 merged). Hosted browser verification pending.

The API now rejects provider-tagged accounts for synthetic refresh. Previously the web dashboard still offered refresh controls for those accounts and included them in bulk refresh requests, producing avoidable partial rejection.

- Derive eligible accounts from the last successful overview snapshot; dispatch only eligible mock account IDs, disable bulk refresh with no eligible accounts, and explain the provider limitation visibly.
- Disable provider-tagged account row controls and concurrent row refresh controls; preserve role gates.
- Extend the Chromium verification script with mixed-source and provider-only synthetic states, checking disabled row control, exact bulk POST IDs (intercepted, not executed) and provider-only bulk denial. Restore original synthetic fixture source tags before continuing.
- No live provider or new capability claim. Snapshot freshness is not authoritative; the server independently rechecks eligibility. No cross-engine-specific source-control proof until tested; lifecycle/verification levels remain unchanged.

## Hosted PR #87 functional-head evidence

GitHub Actions on `4ccca3da281070fb58e9f01e09af7a2730209900` (2026-11-27 UTC):

- [Standard CI #46028478057](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46028478057) and [push CI #46028447303](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46028447303) passed. PR logs record 208/208 Node tests, zero failures/skips/cancellations. Lint, plan alignment, security, SBOM/CycloneDX, dependency audit, build, smoke and doctor succeeded.
- [Browser #46028478077](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46028478077): all three jobs passed. Chromium browser-verify.mjs completed, including the newly added mixed-source and provider-only refresh assertions, with native zoom and simulated text resize checks also green. Firefox/WebKit existing isolated responsive and keyboard checks passed; these do not run the new Chromium-specific source scenarios.
- [Trusted ledger #46028478046](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46028478046): succeeded; 20 tasks, 6 verified, 9 testing, 3 in progress, 2 blocked.
- Service integration workflow was not triggered for this UI-only diff; no new PG/Redis evidence is claimed.

Final evidence-only head verification and merge pending. No live provider, full WCAG, or production authorization proof; lifecycle and verification levels unchanged.
