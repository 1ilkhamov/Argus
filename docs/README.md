# Argus Documentation

This directory contains the current maintained documentation for Argus.

If a document here conflicts with the code, treat the code as the source of truth. The main reference points are:

- `README.md`
- `backend/src/app.module.ts`
- `backend/src/config/defaults.ts`
- `backend/src/config/configuration.ts`
- `backend/src/config/validate-environment.ts`
- `backend/src/tools/tools.module.ts`
- `frontend/vite.config.ts`
- `frontend/src/config/api-endpoints.ts`
- `docker-compose.yml`

## What Argus is

Argus is a local-first AI assistant workspace with three main parts:

- a root CLI (`argus-one`) for onboarding, health checks, and local launch
- a NestJS backend that owns chat, memory, tools, settings, auth, and Telegram integrations
- a React/Vite frontend for chat, settings, memory inspection, and tool visibility

The project also supports optional vector recall via Qdrant, optional Telegram bot and Telegram client channels, and a configurable soul/identity layer for the agent.

## Repository layout

```text
Argus/
├── backend/   # NestJS API, chat runtime, tools, memory, Telegram integrations
├── cli/       # Root CLI: onboard, doctor, start
├── docs/      # Current project documentation
├── frontend/  # React/Vite client UI
├── docker-compose.yml
└── README.md
```

## Documentation map

- `backend.md`
  - backend architecture, modules, request flow, APIs, tools, storage
- `frontend.md`
  - frontend structure, pages, API integration, runtime behavior
- `operations.md`
  - local setup, env files, Docker, tests, data locations, reset workflow
- `release-0.2.0.md`
  - version-specific runbook for ops/runtime migration, smoke checks, and rollback
- `release-0.2.3.md`
  - version-specific runbook for runtime hardening, diagnostics, continuation checkpoints, and rollback
- `soul-customization.md`
  - how the agent soul config is loaded and how to override it safely

## Recommended reading order

1. `README.md`
2. `docs/backend.md`
3. `docs/frontend.md`
4. `docs/operations.md`
5. `docs/release-0.2.0.md` if you are preparing or reviewing the 0.2.0 release
6. `docs/release-0.2.3.md` if you are preparing or reviewing the 0.2.3 release
7. `docs/soul-customization.md` if you need personality customization

## Documentation scope

This docs set is intentionally small.

It is meant to answer:

- what the project is
- how the backend and frontend are structured today
- how to run it locally and in Docker
- where the data lives
- how the agent personality override works

Long-lived plans, audits, temporary investigations, and one-off notes should not be kept here unless they are still actively maintained and useful.
