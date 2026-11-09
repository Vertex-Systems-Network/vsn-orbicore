# GitHub Copilot instructions

Read [`AGENTS.md`](../AGENTS.md) for canonical rules, the master directive `AI_Native_Multi_Hosting_Master_Prompt.md`, and current state in `docs/PROJECT_STATE.md`, `docs/NEXT_ACTION.md`, `docs/BACKLOG.md`, `docs/ARCHITECTURE.md`, and `docs/HANDOFF.md`.

Keep provider APIs behind capability-aware adapters; validate untrusted input and isolate tenants in every layer. Do not hardcode or expose secrets. Preserve truthful feature status: fixtures do not prove live integrations. Implement and verify locally, record evidence, review the diff, and use the authorized branch. Production, irreversible, DNS, cost-bearing, and customer-data actions require scoped authorization.
