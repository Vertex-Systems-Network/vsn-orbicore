# ORB-004/005/016 — deny late SQLite source hold in a pre-existing local worker

**Date:** 2026-11-23 UTC. **Status:** Feature implementation; hosted GitHub Actions checks pending. This is a *synthetic CI-only fixture* safeguard and does not activate real work, provider side effects, or a production release protocol.

## Gap and scope

The previously merged durable source marker guard checks source startup before restart recovery. However, a local SQLite app already started *before* the marker is established can still poll and claim queued jobs. This would modify a source that is supposed to remain signed and inert for quarantine review. The existing mock inventory worker is synchronous, with no real provider access; it does not prove distributed or in-flight effect fencing.

## Implementation

- Make `processNextJob()` use the existing `BEGIN IMMEDIATE` transaction helper to check `rejectCiSourceRecoveryHold` and claim queued work under one SQLite writer lock. A concurrent marker DDL cannot commit between guard and claim. A marker from another connection is visible to the pre-existing app.
- Check the guard again in *both* completion and error-audit write transactions; if marker arrived after claim, do not rewrite job/account or audit history. Propagate hold-denial rather than treating it as a normal refresh failure.
- On a late marker, stop the already-running local worker polling interval after a single rejection, with only a constant non-secret diagnostic. Unexpected timer failures also stop instead of repeating unhandled Promise rejections.
- Two new Node tests cover manual worker claim rejection and a real pre-existing 250ms timer against a marker created via a second file-backed SQLite handle. Assert queued row and relevant audit unchanged, no process crash.

## Required tests / evidence

- GitHub standard PR CI: `npm ci`, Node tests including 2 additions, plan check, security, SBOM, npm audit, TypeScript/build, smoke and doctor.
- Existing 28-job hosted PG16/Redis7 integration, Chromium/WebAuthn/a11y and trusted PR task ledger. Record actual tested SHA/URLs before merge.
- Re-run on final documentation PR head; verify main CI after squash merge.

## Important limits

This does **not** stop an already-executing remote provider side effect, an external direct SQLite writer, a PostgreSQL/Redis worker, an HTTP mutator outside the local worker, or a held job already claimed before marker creation. No active-job replay, CI marker removal API, signed operator release, real MFA/credential migration, cross-store atomicity, independent key custody or off-host restore is created. ORB-004 remains `testing/integration_tested`; ORB-005 remains `in_progress/integration_tested`.
