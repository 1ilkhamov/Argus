# Backend

## Overview

The backend is a NestJS 11 application located in `backend/`.

It is the main runtime for Argus and owns:

- chat and streaming responses
- memory capture, recall, and memory APIs
- tool orchestration and tool safety
- settings storage
- authentication and public session support
- Telegram bot integration
- Telegram client integration
- health endpoints and operational status

The application entrypoint is `backend/src/main.ts`.

## Runtime defaults

Current default local runtime values come from `backend/src/config/defaults.ts`.

- **Backend URL**: `http://localhost:2901`
- **API prefix**: `/api`
- **Default CORS origin**: `http://localhost:2101`
- **Default LLM provider**: `local`
- **Default local LLM base**: `http://localhost:8317/v1`
- **Default storage driver**: `sqlite`
- **Default chat DB**: `data/chat.db`
- **Default memory DB**: `data/memory.db`
- **Default rate-limit DB**: `data/rate-limit.db`

The backend enables:

- Helmet
- validation pipes
- global HTTP exception filter
- logging interceptor
- CORS with `credentials: true`
- trusted proxy handling via `TRUST_PROXY_HOPS`

## Top-level modules

`backend/src/app.module.ts` currently wires these modules:

- `AppConfigModule`
- `AuthModule`
- `LlmModule`
- `TranscriptionModule`
- `ToolsModule`
- `SettingsModule`
- `ChatModule`
- `HealthModule`
- `TelegramModule`
- `TelegramClientModule`

## Main backend domains

### Chat

Location: `backend/src/chat`

Responsibilities:

- conversation creation, loading, deletion
- message handling for full-response and streaming modes
- turn preparation and system prompt construction
- response validation and retry
- tool-aware completion path
- conversation persistence
- fire-and-forget capture after each turn

High-level flow:

1. Accept user input.
2. Load or create conversation.
3. Resolve mode, user profile, response directives, archive evidence, recall, and identity context.
4. Build prompt messages.
5. Run the tool orchestrator when tools are enabled.
6. Validate or rewrite the draft when strict compliance or memory grounding requires it.
7. Persist the assistant reply.
8. Capture new memory from the turn.

### Memory

Location: `backend/src/memory`

Responsibilities:

- memory entry CRUD
- recall and retrieval
- archive evidence retrieval
- deterministic memory commands
- memory lifecycle jobs
- optional vector-backed semantic search with Qdrant
- embedding backfill support

The memory system is optional in its semantic layer:

- plain storage works without Qdrant
- vector recall becomes available when embeddings + Qdrant are configured

### Tools

Location: `backend/src/tools`

Responsibilities:

- tool registry
- execution and orchestration loop
- tool safety policy
- HTTP exposure of available tools
- built-in tool implementations

Current built-in categories from `ToolsModule`:

- **Web**: `web_search`, `web_fetch`, `http_request`, browser tools
- **Memory**: `memory_manage`, `knowledge_search`
- **System**: `system_run`, `file_ops`, `clipboard`, `notify`, `vision`, `pdf_read`, `sql_query`, `applescript`, `process`
- **Compute**: `calculator`, `code_exec`, `datetime`, `audio_transcribe`, `document_gen`
- **Scheduling**: cron tools
- **Automation**: webhooks
- **Communication**: email
- **Orchestration**: sub-agent tools

Tool visibility is filtered by safety policy and optional allow/block lists.

### LLM

Location: `backend/src/llm`

Supported providers:

- `local`
- `openai`
- `anthropic`
- `google`

Defaults are provider-aware. The final runtime values are normalized and validated from environment variables.

### Auth and access control

Location: `backend/src/common/auth`

Supported patterns:

- API key auth
- optional public sessions via signed cookies
- separate admin API key for admin-only surfaces

The frontend is already prepared to work with cookie-based public sessions because it sends `credentials: 'include'`.

### Settings

Location: `backend/src/settings`

Responsibilities:

- store runtime settings through API
- optionally encrypt sensitive values with `SETTINGS_ENCRYPTION_SECRET`
- provide a place for integration credentials that should not live in the repo

### Telegram

Locations:

- `backend/src/telegram`
- `backend/src/telegram-client`

Two different channels exist:

- **Telegram bot**: user talks to a bot account that calls the backend chat flow
- **Telegram client**: Argus connects as a real Telegram user via MTProto and can monitor chats, read history, and generate replies

The Telegram client path also passes source chat metadata into the tool execution context so tools such as `notify` can keep chat context.

## Main HTTP surfaces

All routes are served under `/api`.

### Core routes used by the frontend

- `GET /api/health`
- `GET /api/chat/conversations`
- `GET /api/chat/conversations/:id`
- `DELETE /api/chat/conversations/:id`
- `POST /api/chat/messages`
- `POST /api/chat/messages/stream`
- `POST /api/chat/voice/stream`
- `GET /api/memory/v2/entries`
- `POST /api/memory/v2/entries`
- `PATCH /api/memory/v2/entries/:id`
- `GET /api/memory/v2/stats`
- `GET /api/settings`
- `PUT /api/settings/:key`
- `GET /api/tools`
- `GET /api/telegram/status`
- `POST /api/telegram/restart`
- `POST /api/telegram/stop`
- `GET /api/telegram-client/status`
- `POST /api/telegram-client/start`
- `POST /api/telegram-client/stop`
- `POST /api/telegram-client/restart`
- Telegram client auth endpoints under `/api/telegram-client/auth/*`

### Additional operational routes

- `GET /api/health/runtime`
- `POST /api/hooks/:name`
- memory admin and maintenance routes in `memory/v2`, including embedding backfill

## Storage and data layout

Default local data lives in `backend/data/`.

Important files and folders:

- `chat.db` — chat conversations
- `memory.db` — memory entries and related memory state
- `rate-limit.db` — local rate-limit persistence
- `documents/` — generated documents
- `screenshots/` — tool screenshots
- `qdrant-storage/` — optional local vector storage/runtime data

Supported storage drivers:

- `sqlite` — default local mode
- `file` — JSON/file-based storage compatibility path
- `postgres` — production-capable relational storage

## Testing and scripts

Backend scripts from `backend/package.json`:

- `npm run start:dev`
- `npm run build`
- `npm run lint`
- `npm test`
- `npm run test:e2e`

## What to update when backend behavior changes

Update this document if you change:

- top-level modules in `AppModule`
- default ports or storage paths
- supported LLM providers
- tool categories or notable tool behavior
- Telegram integration model
- primary API surfaces used by the frontend
