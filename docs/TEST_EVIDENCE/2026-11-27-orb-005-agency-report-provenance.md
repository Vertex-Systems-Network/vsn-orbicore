# ORB-005/009 — agency report provenance

Date: 2026-11-27 UTC. Base main 361924cd3c149318a854eb11cfca78a92934efc2 (PR #92 merged). Hosted verification pending.

Agency readiness report v2 restricts hosting portfolio totals, account details, completed dry-run snapshots, storage policy estimates and migration counts to synthetic accounts in the tenant. Both migration endpoints and site ownership must match. Provider inventory is counted separately as excluded, without asserting live health or permissions. No eligible quota is represented by null utilization instead of 0%. Local SQLite backup/restore and team metrics remain organization-wide.

The UI labels the synthetic and local scopes explicitly and exposes the excluded counts; JSON download carries the new scope contract. Report version bumped from 1 to 2 because totals have changed semantics. Existing completed synthetic snapshot field retained for compatibility within the versioned schema; it does not prove provider backup integrity. HTTP regression exercises all-mock, mixed-source and provider-only states and retained local metrics. No dedicated new browser assertion, live provider evidence or production authority. Lifecycle levels unchanged.
