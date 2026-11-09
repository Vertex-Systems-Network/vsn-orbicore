# AI agent compatibility

| Tool | Entry point | Current-state pointers | Status |
|---|---|---|---|
| Codex / general agents | `AGENTS.md` | project state, next action, backlog, handoff | Canonical rules available |
| Claude Code | `CLAUDE.md` | same canonical documents | Adapter entry point available; verify tool behavior against current official docs when needed |
| Cursor | `.cursor/rules/project.mdc` | same canonical documents | Always-apply project rule available |
| Gemini CLI | `GEMINI.md` | same canonical documents | Adapter entry point available; verify tool behavior against current official docs when needed |
| GitHub Copilot | `.github/copilot-instructions.md` | same canonical documents | Instructions available |

Tool-specific rules must remain short adapters to `AGENTS.md`, not duplicate conflicting policy. No agent tool has authority to access an account or environment not explicitly authorized by the owner.
