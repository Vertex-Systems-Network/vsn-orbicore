# ORB-004/005/016 — deny late SQLite source hold in a pre-existing local worker

**Date:** 2026-11-23 UTC. **Status:** Functional PR SHA `af23563ed35c9f410e7141e785640ece78b5ae6f` passed hosted GitHub Actions CI. Documentation-head CI and merge pending. This is a *synthetic CI-only fixture* safeguard and does not activate real work, provider side effects, or a production release protocol.

## Gap and scope

The previously merged durable source marker guard checks source startup before restart recovery. However, a local SQLite app already started *before* the marker is established can still poll and claim queued jobs. This would modify a source that is supposed to remain signed and inert for quarantine review. The existing mock inventory worker is synchronous, with no real provider access; it does not prove distributed or in-flight effect fencing.

## Implementation

- Make `processNextJob()` use the existing `BEGIN IMMEDIATE` transaction helper to check `rejectCiSourceRecoveryHold` and claim queued work under one SQLite writer lock. A concurrent marker DDL cannot commit between guard and claim. A marker from another connection is visible to the pre-existing app.
- Check the guard again in *both* completion and error-audit write transactions; if marker arrived after claim, do not rewrite job/account or audit history. Propagate hold-denial rather than treating it as a normal refresh failure.
- On a late marker, stop the already-running local worker polling interval after a single rejection, with only a constant non-secret diagnostic. Unexpected timer failures also stop instead of repeating unhandled Promise rejections.
- Two new Node tests cover manual worker claim rejection and a real pre-existing 250ms timer against a marker created via a second file-backed SQLite handle. Assert queued row and relevant audit unchanged, no process crash.

## Observed hosted test evidence and remaining gates

- [PR standard CI #45180640568](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45180640568) and [branch CI #45180584300](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45180584300) both passed on `af23563e`: **164/164 Node tests**, zero failures, including the two new late-hold tests; `npm ci`, plan/lint, security, official offline schema/SBOM, audit, build, smoke and doctor all passed.
- [Hosted PostgreSQL16/Redis7 #45180640588](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45180640588) **28/28 jobs passed**. [Chromium/WebAuthn/a11y #45180640851](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45180640851) succeeded, as did [trusted task ledger #45180640212](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45180640212).
- **Remaining:** repeat final documentation-head PR CI, verify `main` postmerge CI. No host/provider operations ran.

## Important limits

This does **not** stop an already-executing remote provider side effect, an external direct SQLite writer, a PostgreSQL/Redis worker, an HTTP mutator outside the local worker, or a held job already claimed before marker creation. No active-job replay, CI marker removal API, signed operator release, real MFA/credential migration, cross-store atomicity, independent key custody or off-host restore is created. ORB-004 remains `testing/integration_tested`; ORB-005 remains `in_progress/integration_tested`.
