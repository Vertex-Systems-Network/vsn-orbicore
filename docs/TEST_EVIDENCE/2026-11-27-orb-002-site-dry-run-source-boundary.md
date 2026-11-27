# ORB-002/005/009 — site dry-run source boundary

Date: 2026-11-27 UTC. Base main 4240c2e32b73226bb9155dfaf9e0d2a6ce4f955f (PR #88 merged). Hosted verification pending.

Site inspection, synthetic archive/preflight/DNS checks and WordPress staging/update routes previously used synthetic capability data without enforcing the parent account source.

- Provider-tagged accounts receive redacted HTTP 409 for inspection and all seven supported site-action/lifecycle variants. Mutations recheck the site/account source after the request body and again under the SQLite writer lock.
- Dashboard only renders a matching synthetic site inspection. Stale asynchronous results are discarded; errors show a retry and no synthetic controls.
- HTTP regression verifies provider rejection across all seven variants, unchanged snapshot/WordPress/audit rows, and restored synthetic inspection. Existing mock success and role/capability regressions remain.

No live calls, actual backups, WordPress updates, DNS changes or production authority promotion. Migration/storage/automation gates are separate work. No new dedicated browser assertion for this inspection path yet; hosted browser suite pending. Lifecycle/verification levels unchanged.

## Hosted PR #89 functional-head evidence

GitHub Actions on `207fe3a02d7c105070681098bf519b760ead9707` (2026-11-27 UTC):

- [Standard CI #46075807845](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46075807845) and [push CI #46075789897](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46075789897) passed. PR logs record 210/210 Node tests, zero failures/skips/cancellations, including the provider-site rejection regression across all seven write variants, with unchanged snapshot, WordPress and audit rows and restored mock inspection. Plan alignment passed.
- [Service integration #46075807959](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46075807959): 28/28 disposable PostgreSQL/Redis jobs succeeded.
- [Browser #46075807866](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46075807866): Chromium, Firefox and WebKit jobs 3/3 succeeded. Existing browser coverage only; new site-inspection error/retry and stale-response behavior lack dedicated browser assertions.
- [Trusted ledger #46075807938](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46075807938): succeeded; 20 tasks, 6 verified, 9 testing, 3 in progress, 2 blocked.

Final evidence-only head verification and merge pending. No live provider calls, production permissions or migration/storage/automation source-policy proof; lifecycle and verification levels unchanged.
