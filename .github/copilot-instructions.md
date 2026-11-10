# GitHub Copilot instructions

Read [`AGENTS.md`](../AGENTS.md), the master directive `AI_Native_Multi_Hosting_Master_Prompt.md`, and current state in `docs/PROJECT_STATE.md`, `docs/NEXT_ACTION.md`, `docs/BACKLOG.md`, `docs/ARCHITECTURE.md`, and `docs/HANDOFF.md`.

Use only `Vertex-Systems-Network/vsn-orbicore`. Work on a feature branch through GitHub, run required checks in GitHub Actions, review the complete PR diff/checks, then merge after success. Do not clone or make local-only edits. Report the exact constraint if GitHub tools cannot perform an operation. Keep APIs capability-aware, validate inputs, isolate tenants, protect secrets, and require scoped authorization for production/destructive actions.
