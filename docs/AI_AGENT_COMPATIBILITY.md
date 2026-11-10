# AI agent compatibility

| Tool | Entry point | Current-state pointers | Status |
|---|---|---|---|
| Codex / general agents | `AGENTS.md` | project state, next action, backlog, handoff | Canonical rules available |
| Claude Code | `CLAUDE.md` | same canonical documents | Adapter entry point available; verify tool behavior against current official docs when needed |
| Cursor | `.cursor/rules/project.mdc` | same canonical documents | Always-apply project rule available |
| Gemini CLI | `GEMINI.md` | same canonical documents | Adapter entry point available; verify tool behavior against current official docs when needed |
| GitHub Copilot | `.github/copilot-instructions.md` | same canonical documents | Instructions available |

All adapters require the GitHub-only workflow in `AGENTS.md`: branch/PR/Actions/review/merge through the canonical repository; no local clone or local-only checkpoint. Tool-specific rules remain short adapters, and no agent has authority to access an account or environment the owner has not authorized.
