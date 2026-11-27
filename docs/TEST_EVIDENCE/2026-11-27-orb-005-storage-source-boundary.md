# ORB-005/009 — synthetic storage provenance boundary

Date: 2026-11-27 UTC. Base main 5fbe9da66381bd49c932efe8f38fafa683e26e91 (PR #90 merged). Hosted verification pending.

Storage policy creation and simulation drills now deny provider accounts before changes and recheck under the SQLite writer lock. Provider-account offload/reclaim projections return null rather than fabricated fixture percentages; historical policy metadata remains visible, with drill eligibility false. UI selects only mock accounts, disables ineligible drills and explains unavailable estimates.

HTTP regression covers initial policy creation on mock data, provider rejection of subsequent creation and all three drill variants, null estimates, unchanged policy/audit rows, and resumed mock drill. No real object-store calls, file movement, credentials, production permission or dedicated browser proof. Lifecycle/verification levels unchanged.

## Hosted PR #91 functional-head evidence

GitHub Actions on `075732654261e93fb16cc51193122f20b26690ef` (2026-11-27 UTC):

- [Standard CI #46080035981](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46080035981) and [push CI #46080014786](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46080014786) passed. PR logs record 212/212 Node tests, zero failures/skips/cancellations, including the new provider storage policy/drill rejection regression, null estimates, unchanged policy/audit rows and resumed mock drill. Plan alignment passed.
- [Service integration #46080035994](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46080035994): 28/28 disposable PostgreSQL/Redis jobs succeeded.
- [Browser #46080036009](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46080036009): Chromium, Firefox and WebKit 3/3 jobs succeeded. Existing browser coverage only; no dedicated provider-storage UI scenario.
- [Trusted ledger #46080035924](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46080035924): succeeded; 20 tasks, 6 verified, 9 testing, 3 in progress, 2 blocked.
- Prior PR #90 [post-merge main CI #46079877896](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46079877896) passed at `5fbe9da66381bd49c932efe8f38fafa683e26e91`.

Final evidence-only head verification and merge pending. No live provider calls, object-store transfer, production permission or automation source-policy proof; lifecycle and verification levels unchanged.
