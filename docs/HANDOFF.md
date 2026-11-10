# Handoff

## Latest verified checkpoint

- Correct repo: `Vertex-Systems-Network/vsn-orbicore`; audit baseline `main`: `fac13611c21cfbeec6148a7cbd93a0799dfc4c45`.
- PR #2 merged WebAuthn server/UI at `bdd3b6179d911cb0abdd3a35f9aefb17dca02ab5`; PR #3 merged passkey inventory/revocation/rebinding at `c4cdab76a82578fc4db698b04098e0234e5570a2`; PR #4 synchronized docs.
- Actions runs: [PR #2](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/42733887820), [PR #3](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/42734476163), [PR #4](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/42734679968). Evidence index: `docs/TEST_EVIDENCE/2026-11-10-github-ci.md`.
- CI covers npm install, tests (20 then 21), lint, build, smoke and doctor. It does not establish browser/physical authenticator behavior, verified email, DB/queue services, production key rotation/restore, accessibility, live providers or release readiness.
- The audit repair PR is not verified until its own Actions run completes. All subsequent project edits use GitHub-only feature-branch/PR workflow.

## Resume from current main

1. Read `AGENTS.md`, project state, next action, backlog and task JSON on current `main`.
2. Execute ORB-012 first with hosted Chromium and WebAuthn virtual authenticator; capture run and artifacts.
3. Then execute ORB-015, ORB-016 and ORB-018 as bounded tasks and record evidence.
4. Implement ORB-007 local preflight independently; ORB-017 gates production install/upgrade/restore.
5. Keep ORB-013/014 and ORB-006/019 open until exact prerequisites exist.
