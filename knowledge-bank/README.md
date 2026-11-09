# Knowledge and execution bank

This is the versioned structured companion to project docs. JSON Schemas under `schemas/` define Flow, Options, Systems, Integration and Research record shapes. Records use stable IDs and refer to source docs, tasks, tests, or evidence paths. `backlog/tasks.json` is the canonical executable backlog; `knowledge-bank/backlog/delivery.json` is only the epic-to-task index.

Current banks: `flows/`, `options/`, `systems/`, `design/`, `integrations/`, `research/`, `test-evidence/`, and `backlog/`. Validate JSON and schemas before committing; add generated consistency checks as a Phase 1 task. Every option that has no code effect must say `not_implemented` or `planned`.
