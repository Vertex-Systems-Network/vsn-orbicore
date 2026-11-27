# ORB-002/009 — account capability snapshot provenance

Date: 2026-11-27 UTC. Base main 8ae8679993b068709b4e8f29d5783484b2041e17 (PR #87 merged). Hosted verification pending.

The local account capability endpoint previously returned synthetic permission profiles even after an account was tagged as provider. The UI could also retain a previous account's capability snapshot and treated failed requests as empty.

- Provider-tagged accounts expose only the known capability names with unknown levels, no fetched timestamp and live:false. No provider grant is inferred from persisted fixture data. Mock accounts only read mock snapshots.
- Dashboard distinguishes synthetic and unverified provider snapshots, checks response account/source, clears old data, exposes request failure and retry, and refetches on source change.
- One local HTTP regression exercises a persisted mock snapshot before/after a synthetic provenance change. Chromium extends the existing mixed-source test to verify unknown badges, failed fetch without stale permissions, and retry recovery.

No live provider calls or production permission policy changes. This is a display/API evidence boundary, not complete enforcement in every other dry-run feature. New browser assertions are Chromium-specific. Task lifecycle and verification levels unchanged.

## Hosted PR #88 functional-head evidence

GitHub Actions on `4a82a6e6b3f38cff0eaa3c34b9116d88198d0a56` (2026-11-27 UTC):

- [Standard CI #46034277413](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46034277413) and [push CI #46034239701](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46034239701) passed. PR logs record 209/209 Node tests, zero failures/skips/cancellations, including the persisted mock capability snapshot regression. Plan alignment passed.
- [Service integration #46034274956](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46034274956): all 28 disposable PostgreSQL/Redis service jobs succeeded.
- [Browser #46034274959](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46034274959): all three jobs passed. Chromium browser-verify.mjs completed including the provider unknown-level, failed capability request and retry assertions. Existing Firefox/WebKit responsive/keyboard checks passed; they do not prove the new Chromium-specific scenarios.
- [Trusted ledger #46034279311](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46034279311): succeeded; 20 tasks, 6 verified, 9 testing, 3 in progress, 2 blocked.

Final evidence-only head verification and merge pending. No live provider calls, production permission authorization, or complete enforcement in unrelated dry-run modules; lifecycle and verification levels unchanged.
