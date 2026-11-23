# ORB-005 — normal HTTP JSON ingress guard

**Status:** Functional commit `e11333854a0d29ca76ffc2f8b9606a512a653e43` passed GitHub-hosted verification on 2026-11-23 (UTC). The later documentation-only head still needs its own CI before merge.

## Scope and intent

The existing `readJson` streamed each HTTP chunk through `toString("utf8")`, which can replace split multibyte codepoints, and bounded JavaScript string code units rather than received bytes. For non-ASCII JSON, the 32 KiB request limit could therefore accept materially larger bodies. Top-level JSON primitives/arrays could reach route handlers expecting objects and produce a server error. The default HTTP application still uses SQLite identity.

The proposed change uses actual `Buffer.byteLength` per incoming chunk with immediate 413 rejection, joins bounded binary chunks and decodes UTF-8 with `fatal: true`, then rejects top-level JSON values other than objects with HTTP 400. An empty request remains `{}`. No live providers, secrets, database authority or MFA flows are changed.

## Regressions

- JSON body containing 8,500 emoji: fewer than 32,768 UTF-16 units but more than 32,768 UTF-8 bytes; must return 413 and not enqueue a job.
- Invalid UTF-8 byte inside JSON must return 400; top-level `null`, array, string, number and boolean must return 400 without creating a job.
- An emoji deliberately split between HTTP stream chunks in a new team member's Unicode password must remain intact; subsequent login with the original password must succeed.

**Required evidence before approval:** GitHub PR head SHA and successful `.github/workflows/ci.yml` run (unit tests, lint, security gate, build, smoke, doctor); review the test names and branch diff. This is a bounded ORB-005 hardening checkpoint, **not** ORB-005 completion, production identity cutover, external audit custody or full security certification.

## Observed hosted verification

- [Standard PR CI #45140543854](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45140543854) completed **success** on functional SHA `e11333854a0d29ca76ffc2f8b9606a512a653e43`: **130 passing Node tests / 0 failed**, including all three new ORB-005 cases. The job's `npm ci`, `npm test`, `npm run lint` with plan check, `security:check`, CycloneDX schema, `npm audit --audit-level=high`, `npm run build`, `npm run smoke`, and `npm run doctor` steps all passed.
- [Feature-branch CI #45140491318](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45140491318) also completed success on the same functional commit.
- [Chromium/WebAuthn/accessibility #45140543837](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45140543837) completed success, including native 200%/400% zoom and simulated text resizing.
- [23-job PostgreSQL 16/Redis 7 service integration #45140543889](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45140543889) completed success. This is synthetic CI, not production DB cutover.
- [Trusted-base PR task table #45140544078](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45140544078) completed success. ORB-005 remains `in_progress/integration_tested` and ORB-020 remains `verified/integration_tested`.

**Verification limitations:** All tests were hosted in a disposable GitHub environment. This does not demonstrate full external penetration testing, multi-node rate-limit persistence, real provider operation, production authentication authority, browser interoperability beyond the specified Chromium checks, or independently custodied offsite recovery.
