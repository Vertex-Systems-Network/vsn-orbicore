# ORB-005/009 — synthetic automation provenance boundary

Date: 2026-11-27 UTC. Base main 12e38df45f9460566e2f4efbe0fe40b2fdcd4e12 (PR #91 merged). Hosted verification pending.

Advisor excludes provider accounts and their sites; it reports exclusions explicitly and labels synthetic fixture observations configured rather than live measurement. Rule execution reloads the tenant rule under BEGIN IMMEDIATE, checks enabled state in both approval modes, daily cap, and synthetic-only inputs in the same transaction as run/audit persistence. Inventory candidates are restricted to stale or missing timestamps. Quota and snapshot summaries exclude provider-tagged records. Provider-only workspaces and paused rules reject without writes. Existing local identity and backup advisory signals remain.

HTTP regression exercises mixed-source advisor, all three rule types, paused bounded rule, provider-only rejection and unchanged run/rule/audit rows. UI explains scope and disables paused controls. Agency report aggregation is separate work; no dedicated new browser proof, live provider calls or autonomous execution. Lifecycle and verification levels unchanged.

## Hosted PR #92 functional-head evidence

GitHub Actions on `1860cea86aeb32c5dd5d63979cd0f69b786a2df8` (2026-11-27 UTC):

- [Standard CI #46081154498](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46081154498) and [push CI #46081136896](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46081136896) passed. PR logs record 213/213 Node tests, zero failures/skips/cancellations, including the new mixed-source advisor and automation regression, stale candidates, paused bounded rule rejection, provider-only rejection and unchanged rule/run/audit records. Existing daily cap regression and plan alignment passed.
- [Service integration #46081154432](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46081154432): 28/28 disposable PostgreSQL/Redis jobs succeeded.
- [Browser #46081154443](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46081154443): Chromium, Firefox and WebKit 3/3 jobs succeeded. Existing browser coverage only; no dedicated new automation source-policy UI assertion.
- [Trusted ledger #46081154463](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46081154463): succeeded; 20 tasks, 6 verified, 9 testing, 3 in progress, 2 blocked.
- Prior PR #91 [post-merge main CI #46081075898](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46081075898) and [CI #46081031251](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46081031251) passed at `12e38df45f9460566e2f4efbe0fe40b2fdcd4e12`.

Final evidence-only head verification and merge pending. No live provider calls, autonomous execution, production permission or agency report aggregate provenance proof; lifecycle and verification levels unchanged.
