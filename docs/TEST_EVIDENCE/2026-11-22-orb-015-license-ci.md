# ORB-015 supply-chain license gate CI repair — 2026-11-22

- **Repository:** `Vertex-Systems-Network/vsn-orbicore`
- **Baseline main SHA:** `7ecdef1b1f1fd93641c15cb6c24830d2b47cf18b`
- **PR:** [#6](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/6)
- **Tested head SHA:** `a42e8cedd7a4ebd4ac4157ef2ff241c6b1dcf593` (before evidence-only commit)
- **Actions run:** [44994225836](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44994225836)
- **Runner:** GitHub Actions `ubuntu-latest`, `actions/setup-node@v4` with Node 24; exact runner patch and npm patch not captured here.
- **Jobs:** `verify` conclusion `success`, including `npm ci`, `npm test`, `npm run lint`, `npm run security:check`, `npm run build`, `npm run smoke`, `npm run doctor`.
- **Artifacts:** No downloadable artifact claimed; workflow run and logs are the evidence.
- **Reason:** Transitive `caniuse-lite@1.0.30001823` declares CC-BY-4.0; narrowly reviewed versioned exception and attribution recorded in `docs/THIRD_PARTY_NOTICES.md`.
- **Limitations:** Unit/static CI only; does not establish complete legal/release review, browser E2E, live hosting, Docker/PostgreSQL, Redis, or physical authenticator behavior. Follow-up evidence-only commit must also pass CI before merge.

The earlier failure was [main run 44980063547](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44980063547), `npm test`, supply-chain assertion (41/42 passed).
