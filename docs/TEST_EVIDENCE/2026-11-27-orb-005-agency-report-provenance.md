# ORB-005/009 — agency report provenance

Date: 2026-11-27 UTC. Base main 361924cd3c149318a854eb11cfca78a92934efc2 (PR #92 merged). Hosted verification pending.

Agency readiness report v2 restricts hosting portfolio totals, account details, completed dry-run snapshots, storage policy estimates and migration counts to synthetic accounts in the tenant. Both migration endpoints and site ownership must match. Provider inventory is counted separately as excluded, without asserting live health or permissions. No eligible quota is represented by null utilization instead of 0%. Local SQLite backup/restore and team metrics remain organization-wide.

The UI labels the synthetic and local scopes explicitly and exposes the excluded counts; JSON download carries the new scope contract. Report version bumped from 1 to 2 because totals have changed semantics. Existing completed synthetic snapshot field retained for compatibility within the versioned schema; it does not prove provider backup integrity. HTTP regression exercises all-mock, mixed-source and provider-only states and retained local metrics. No dedicated new browser assertion, live provider evidence or production authority. Lifecycle levels unchanged.

## Hosted PR #93 functional-head evidence

GitHub Actions on `a4d39923361f03c6e832da24cd9d49a6fe83d489` (2026-11-27 UTC):

- [Standard CI #46082024819](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46082024819) and [push CI #46082007298](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46082007298) passed. PR logs record 214/214 Node tests, zero failures/skips/cancellations, including agency report provenance, mixed-source and provider-only states, version 2 contract and retained local metrics. Plan alignment passed.
- [Browser #46082024840](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46082024840): Chromium, Firefox and WebKit 3/3 jobs succeeded. Existing browser coverage only; no dedicated new agency-report UI assertion.
- [Trusted ledger #46082024602](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46082024602): succeeded; 20 tasks, 6 verified, 9 testing, 3 in progress, 2 blocked.
- Service integration did not trigger on this functional head; no new PostgreSQL/Redis result is claimed. Prior PR #92 service integration passed 28/28 and its [post-merge main CI #46081941980](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46081941980) passed at `361924cd3c149318a854eb11cfca78a92934efc2`.

Final evidence-only head verification and merge pending. No live provider evidence or production readiness promotion; lifecycle and verification levels unchanged.
