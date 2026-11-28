# ORB-009/018 — mixed-source browser regression batch

Base main 1912b5006dc6bf7edd8298227ef10d932974b0c6; previous PR #93 final hosted checks passed and merged. Hosted verification pending.

Two separate commits extend the existing Chromium script to check real provider-tagged fixture inspection rejection and retry, synthetic site recovery, mixed-source migration/storage selector eligibility and unavailable projections, advisor/report exclusion, and provider-only planner/storage disabled controls plus empty synthetic report totals. Test provenance changes are confined to disposable in-memory data and restored in the existing finally block. No new live provider or cross-engine-specific scenario proof, manual accessibility, production action or lifecycle promotion.

Operator protocol: continue eligible development while checks run, stage meaningful commits without changing the published branch ref, then publish a coordinated ref update after previous checks complete. Canonical AGENTS.md requires GitHub-only work (no local clone/checkpoint); local execution is not claimed. Hosted workflow evidence remains authoritative.
