# ORB-005/009 — synthetic storage provenance boundary

Date: 2026-11-27 UTC. Base main 5fbe9da66381bd49c932efe8f38fafa683e26e91 (PR #90 merged). Hosted verification pending.

Storage policy creation and simulation drills now deny provider accounts before changes and recheck under the SQLite writer lock. Provider-account offload/reclaim projections return null rather than fabricated fixture percentages; historical policy metadata remains visible, with drill eligibility false. UI selects only mock accounts, disables ineligible drills and explains unavailable estimates.

HTTP regression covers initial policy creation on mock data, provider rejection of subsequent creation and all three drill variants, null estimates, unchanged policy/audit rows, and resumed mock drill. No real object-store calls, file movement, credentials, production permission or dedicated browser proof. Lifecycle/verification levels unchanged.
