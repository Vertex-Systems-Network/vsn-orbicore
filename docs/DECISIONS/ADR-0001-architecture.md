# ADR-0001: TypeScript modular monolith and local proof-of-concept storage

**Status:** accepted for initial architecture; exact framework/ORM and production services remain revisitable.
**Date:** 2026-11-09
**Decision owner:** project maintainers

## Context

The product requires a web-first UI, stable API reused by desktop/mobile later, provider adapters, auditable long-running jobs and a self-hostable VPS path. The repository is greenfield. Local verification environment has Node.js/npm but no Docker/PostgreSQL/Redis. Master directive asks for a mock cPanel inventory proof and local end-to-end path before broader implementation.

## Candidates (estimated 1–5 scores)

Weights: cross-platform/API reuse 20%, provider and job ecosystem 20%, self-host/local setup 15%, security/maintainability 15%, modest resource envelope 10%, implementation/typing/AI ecosystem 10%, portability/licensing 10%. Scores are an engineering estimate, not measured benchmark.

| Candidate | Cross-platform | Integrations/jobs | Setup | Security/maintainability | Footprint | Team/tooling | Portability | Weighted |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| React + TypeScript, NestJS modular monolith, PostgreSQL, BullMQ/Redis | 5 | 5 | 3 | 4 | 3 | 5 | 5 | 4.35 |
| React + TypeScript, Laravel/PHP backend, PostgreSQL, Laravel queues | 3 | 4 | 4 | 4 | 4 | 3 | 4 | 3.65 |
| React + TypeScript, Go API/workers, PostgreSQL, separate queue integration | 4 | 4 | 3 | 4 | 5 | 3 | 5 | 3.95 |

## Decision and consequences

Adopt TypeScript across the React web UI and Node API, modular monolith first, PostgreSQL for production state and Redis/BullMQ for distributed workers. NestJS offers adapter/module boundaries and first-party documented integrations; TypeScript shares contracts across clients. Tradeoffs are higher Node runtime/resource overhead than Go, and Redis adds an operational dependency. Validate actual modest-VPS resource cost before setting minimums.

For the first local proof use SQLite only as a single-user developer mode because PostgreSQL/Redis are absent. Do not call this feature-equivalent production support. Keep DB and queue interfaces replaceable and record Node's built-in SQLite experimental status if that API is used; prefer a stable adapter before shipping. The long-term production choice stays PostgreSQL + Redis, not one-process SQLite jobs.

## UI system choice

Use React + TypeScript with a coherent accessible primitive/design system. Start with a small original token set and accessible primitives; evaluate shadcn/ui (MIT, source-owned components) against Mantine (MIT, broad integrated suite) and Headless UI (unstyled primitives) before adding a broad dependency. Do not copy competitor visual layouts. Exact library selection is pending measured screen needs and accessibility review.

## Evidence and revisit triggers

Sources and current provider constraints are in `docs/RESEARCH/PHASE-0-RESEARCH.md`. Revisit if local installs cannot run on low-cost VPS targets, job recovery needs a dedicated workflow engine, TypeScript deployment limits are measured, or security review finds framework-specific gaps.
