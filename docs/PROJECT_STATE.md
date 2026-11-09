# Project state

**Updated:** 2026-11-09 (UTC)
**Product:** VSN ORBICORE — AI-assisted hosting control plane
**Phase:** Phase 0 exit met; Phase 1 in progress. ORB-001/003/008 verified; inventory slice mock-tested.
**Branch at task start:** `feat/phase-0-foundation`, based on upstream `main` commit `eb2a67ed18f9848ec12484e5d0d7a9f9367ef481`
**Repo at task start:** only README and master directive; no source implementation, CI, docs, or test suite
**Verified environment:** Node.js 24.22.1, npm 11.9.0, Python 3.12; npm registry reachable; Docker/PostgreSQL/Redis absent

## Verified facts

- Public GitHub repository: `Vertex-Systems-Network/vsn-orbicore`; default branch `main`; branch was not protected when inspected.
- The full master directive is present at the root. Its 22 sections govern the product and delivery.
- The directive requires read-only cPanel inventory proof-of-concept, a local API/demo, durable project state, and capability/permission-aware operations.
- cPanel UAPI supports account-context operations. WHM Transfer Tool documentation describes source-server root or `sudo`/`su` access. Remote database exposure is configurable by the host/provider.
- No real cPanel/WHM test account or sandbox was supplied. Provider behavior is unknown and not live-verified.

## Status labels

Use `DESIGNED`, `IMPLEMENTED`, `MOCK-TESTED`, `INTEGRATION-TESTED`, `LIVE-VERIFIED`, `RELEASED`; distinguish `blocked_external` from technical blockers. Planned behavior is not implemented behavior.

## Current checkpoint

- Last verified upstream commit: `eb2a67ed18f9848ec12484e5d0d7a9f9367ef481`.
- Local code: fixture-backed account/site API, SQLite persistence, refresh worker, React dashboard and tests. Local checks are recorded in `docs/TEST_EVIDENCE/2026-11-09-local-poc.md`.
- Feature branch was published to GitHub in the prior checkpoint; the GitHub connector commit differs from local Git commit metadata but represents the same tracked file tree.
- Phase 0 exit criteria are met: research/specification/banks are internally cross-validated and six local tests pass. ORB-001/003/008 are verified; ORB-002 remains mock-tested. Browser QA ORB-009 is a Phase 1 blocker. ORB-005 auth/tenant implementation is next and must precede real credentials.
