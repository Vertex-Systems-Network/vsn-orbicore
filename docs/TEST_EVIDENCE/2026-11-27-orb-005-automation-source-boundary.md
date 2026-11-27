# ORB-005/009 — synthetic automation provenance boundary

Date: 2026-11-27 UTC. Base main 12e38df45f9460566e2f4efbe0fe40b2fdcd4e12 (PR #91 merged). Hosted verification pending.

Advisor excludes provider accounts and their sites; it reports exclusions explicitly and labels synthetic fixture observations configured rather than live measurement. Rule execution reloads the tenant rule under BEGIN IMMEDIATE, checks enabled state in both approval modes, daily cap, and synthetic-only inputs in the same transaction as run/audit persistence. Inventory candidates are restricted to stale or missing timestamps. Quota and snapshot summaries exclude provider-tagged records. Provider-only workspaces and paused rules reject without writes. Existing local identity and backup advisory signals remain.

HTTP regression exercises mixed-source advisor, all three rule types, paused bounded rule, provider-only rejection and unchanged run/rule/audit rows. UI explains scope and disables paused controls. Agency report aggregation is separate work; no dedicated new browser proof, live provider calls or autonomous execution. Lifecycle and verification levels unchanged.
