# ORB-002/005/009 — site dry-run source boundary

Date: 2026-11-27 UTC. Base main 4240c2e32b73226bb9155dfaf9e0d2a6ce4f955f (PR #88 merged). Hosted verification pending.

Site inspection, synthetic archive/preflight/DNS checks and WordPress staging/update routes previously used synthetic capability data without enforcing the parent account source.

- Provider-tagged accounts receive redacted HTTP 409 for inspection and all seven supported site-action/lifecycle variants. Mutations recheck the site/account source after the request body and again under the SQLite writer lock.
- Dashboard only renders a matching synthetic site inspection. Stale asynchronous results are discarded; errors show a retry and no synthetic controls.
- HTTP regression verifies provider rejection across all seven variants, unchanged snapshot/WordPress/audit rows, and restored synthetic inspection. Existing mock success and role/capability regressions remain.

No live calls, actual backups, WordPress updates, DNS changes or production authority promotion. Migration/storage/automation gates are separate work. No new dedicated browser assertion for this inspection path yet; hosted browser suite pending. Lifecycle/verification levels unchanged.
