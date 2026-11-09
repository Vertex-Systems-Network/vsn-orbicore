# Knowledge and execution bank

This versioned structured companion contains flows, options, system components, design decisions, integrations, research, test evidence, and backlog links. JSON Schema records live in `schemas/`. `npm run lint` validates JSON syntax, validates these records against their JSON Schemas, enforces globally unique bank IDs, checks declared test IDs and local source/evidence paths, and verifies local fixture paths. The validator intentionally supports the JSON Schema keywords used by these project schemas; it is not a general draft 2020-12 validator.

`backlog/tasks.json` is the canonical executable backlog; `backlog/delivery.json` is its epic-to-task index. Every option records whether its behavior is implemented, planned, or not implemented. Research and system records link to dated sources, docs, tests, and fixtures where available.
