# ORB-002/009 — account capability snapshot provenance

Date: 2026-11-27 UTC. Base main 8ae8679993b068709b4e8f29d5783484b2041e17 (PR #87 merged). Hosted verification pending.

The local account capability endpoint previously returned synthetic permission profiles even after an account was tagged as provider. The UI could also retain a previous account's capability snapshot and treated failed requests as empty.

- Provider-tagged accounts expose only the known capability names with unknown levels, no fetched timestamp and live:false. No provider grant is inferred from persisted fixture data. Mock accounts only read mock snapshots.
- Dashboard distinguishes synthetic and unverified provider snapshots, checks response account/source, clears old data, exposes request failure and retry, and refetches on source change.
- One local HTTP regression exercises a persisted mock snapshot before/after a synthetic provenance change. Chromium extends the existing mixed-source test to verify unknown badges, failed fetch without stale permissions, and retry recovery.

No live provider calls or production permission policy changes. This is a display/API evidence boundary, not complete enforcement in every other dry-run feature. New browser assertions are Chromium-specific. Task lifecycle and verification levels unchanged.
