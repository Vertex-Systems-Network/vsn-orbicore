# ORB-002 — quota-only capability evidence boundary

Date: 2026-11-27 UTC. Base: main 4d11da11e99dba3fb61e5ac610b27641ba864dba (PR #82 merged). Stage: branch implementation; hosted CI pending.

A successful read-only Quota::get_quota_info response previously returned the entire static standard cPanel profile, including unrelated backup and inventory permissions. This violates the existing product capability discovery and evidence contract in docs/INTEGRATIONS.md and knowledge-bank/integrations/cpanel-uapi.json.

- Return only quotas.read as read_only, with an explicit note that quota values were not validated. All other profile entries are unknown/not probed, without reusing mock permission claims.
- Do not add outbound operations or enable the live adapter. Preserve the fixture profile and the existing denial response.
- Two injected-fetch tests cover one successful quota call with unrelated permissions unknown, fixture immutability, and denied/malformed responses with no capability snapshot.

Verification pending: Node suite, applicable browser and ledger workflows. No real cPanel credentials, network calls or live verification; ORB-002 testing/mock_tested, ORB-006 and ORB-019 blocked, ORB-010 in_progress/unit. No task lifecycle promotion.

## Hosted PR #83 functional-head evidence

GitHub Actions on `62904b91d7cd4452221234362efc719e7b33e485` (2026-11-27 UTC):

- [Standard CI #45997338728](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45997338728): 201/201 Node tests passed, zero failures/skips/cancellations; both new capability tests passed. Lint, plan alignment, security, SBOM/CycloneDX validation, npm audit, build, smoke and doctor succeeded.
- [Browser #45997338745](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45997338745): all three Chromium, Firefox and WebKit jobs succeeded.
- [Trusted ledger #45997338591](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45997338591): succeeded; 20 tasks, 6 verified, 9 testing, 3 in progress, 2 blocked.
- PG16/Redis7 service workflow was not triggered for this scoped adapter change; no new service evidence claimed.

Final evidence-only head verification and merge pending. No real provider calls, quota-value validation, or lifecycle promotion.
