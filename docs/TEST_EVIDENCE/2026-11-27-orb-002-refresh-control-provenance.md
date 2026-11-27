# ORB-002/009 — mock-only inventory refresh controls

Date: 2026-11-27 UTC. Base main e66aa9ca520be9fc071f1d2e7783442a4055551b (PR #86 merged). Hosted browser verification pending.

The API now rejects provider-tagged accounts for synthetic refresh. Previously the web dashboard still offered refresh controls for those accounts and included them in bulk refresh requests, producing avoidable partial rejection.

- Derive eligible accounts from the last successful overview snapshot; dispatch only eligible mock account IDs, disable bulk refresh with no eligible accounts, and explain the provider limitation visibly.
- Disable provider-tagged account row controls and concurrent row refresh controls; preserve role gates.
- Extend the Chromium verification script with mixed-source and provider-only synthetic states, checking disabled row control, exact bulk POST IDs (intercepted, not executed) and provider-only bulk denial. Restore original synthetic fixture source tags before continuing.
- No live provider or new capability claim. Snapshot freshness is not authoritative; the server independently rechecks eligibility. No cross-engine-specific source-control proof until tested; lifecycle/verification levels remain unchanged.
