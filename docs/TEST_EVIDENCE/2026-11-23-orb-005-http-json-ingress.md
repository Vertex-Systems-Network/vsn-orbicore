# ORB-005 — normal HTTP JSON ingress guard

**Status:** Implementation committed for hosted verification; CI outcome must be recorded only after the workflow finishes.

## Scope and intent

The existing `readJson` streamed each HTTP chunk through `toString("utf8")`, which can replace split multibyte codepoints, and bounded JavaScript string code units rather than received bytes. For non-ASCII JSON, the 32 KiB request limit could therefore accept materially larger bodies. Top-level JSON primitives/arrays could reach route handlers expecting objects and produce a server error. The default HTTP application still uses SQLite identity.

The proposed change uses actual `Buffer.byteLength` per incoming chunk with immediate 413 rejection, joins bounded binary chunks and decodes UTF-8 with `fatal: true`, then rejects top-level JSON values other than objects with HTTP 400. An empty request remains `{}`. No live providers, secrets, database authority or MFA flows are changed.

## Regressions

- JSON body containing 8,500 emoji: fewer than 32,768 UTF-16 units but more than 32,768 UTF-8 bytes; must return 413 and not enqueue a job.
- Invalid UTF-8 byte inside JSON must return 400; top-level `null`, array, string, number and boolean must return 400 without creating a job.
- An emoji deliberately split between HTTP stream chunks in a new team member's Unicode password must remain intact; subsequent login with the original password must succeed.

**Required evidence before approval:** GitHub PR head SHA and successful `.github/workflows/ci.yml` run (unit tests, lint, security gate, build, smoke, doctor); review the test names and branch diff. This is a bounded ORB-005 hardening checkpoint, **not** ORB-005 completion, production identity cutover, external audit custody or full security certification.
