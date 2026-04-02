# Operations

## Recommended local workflow

Recommended quick start after cloning the Argus repository:

```bash
git clone https://github.com/1ilkhamov/Argus.git
cd Argus
npx argus-one onboard
npx argus-one doctor
npx argus-one start
```

Alternative repo development workflow from the project root:

```bash
npm install
npm run onboard
npm run doctor
npm run start
```

Recommended published CLI commands from the Argus repo root or any nested directory:

- `npx argus-one onboard`
- `npx argus-one doctor`
- `npx argus-one start`
- `npx argus-one --help`

Alternative root CLI commands from `package.json` and `cli/`:

- `npm run onboard`
- `npm run doctor`
- `npm run start`
- `npm run help`
- `npm run verify`

## What the root CLI does

### `onboard`

The onboarding flow:

- creates or refreshes `backend/.env` and `frontend/.env`
- validates local prerequisites
- installs backend and frontend dependencies when needed
- configures the LLM provider flow
- can prepare the workspace for optional Qdrant usage

### `doctor`

The doctor flow checks:

- Node.js version
- `.env` file presence
- dependency installation state
- frontend and backend port status
- service reachability when already running

### `start`

The start flow:

- starts Qdrant if installed and not already running
- starts the backend if it is not already running
- starts the frontend if it is not already running
- uses backend port from `backend/.env`
- uses frontend port `2101`

## Manual development flow

### Backend

```bash
cd backend
npm install
cp .env.example .env
npm run start:dev
```

Default local backend URL:

- `http://localhost:2901`

### Frontend

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```

Default local frontend URL:

- `http://localhost:2101`

Development proxy behavior:

- frontend proxies `/api` to `VITE_DEV_PROXY_TARGET`
- default target is `http://localhost:2901`
- if `API_KEY` is set, the proxy injects `X-API-Key`

## Environment files

### Backend

Main backend config file:

- `backend/.env`

Template:

- `backend/.env.example`

Main config groups:

- server: `PORT`, `NODE_ENV`, `CORS_ORIGIN`
- LLM: `LLM_PROVIDER`, `LLM_API_BASE`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_MAX_TOKENS`, `LLM_TEMPERATURE`
- auth: `AUTH_ENABLED`, `AUTH_API_KEYS`, `AUTH_ADMIN_API_KEY`
- public sessions: `AUTH_PUBLIC_SESSIONS_ENABLED`, `AUTH_PUBLIC_SESSION_SECRET`, `AUTH_PUBLIC_SESSION_COOKIE_NAME`, `AUTH_PUBLIC_SESSION_TTL_DAYS`
- HTTP / proxy: `TRUST_PROXY_HOPS`
- rate limiting: `RATE_LIMIT_*`
- storage: `STORAGE_DRIVER`, `STORAGE_DB_FILE`, `STORAGE_MEMORY_DB_FILE`, `STORAGE_POSTGRES_URL`
- embeddings and vector recall: `EMBEDDING_*`, `MEMORY_QDRANT_*`
- tools: `TOOLS_*`
- Telegram bot: `TELEGRAM_*`
- Telegram client: `TELEGRAM_CLIENT_*`
- settings encryption: `SETTINGS_ENCRYPTION_SECRET`
- soul override: `SOUL_CONFIG_PATH`
- hooks: `HOOKS_ENABLED`

### Frontend

Main frontend config file:

- `frontend/.env`

Template:

- `frontend/.env.example`

Current frontend env surface:

- `VITE_API_BASE`
- `VITE_DEV_PROXY_TARGET`
- `API_KEY`
- `ADMIN_API_KEY`

## Local data and reset points

Default local runtime data lives in `backend/data/`.

Important files and folders:

- `chat.db` — chat history
- `memory.db` — memory storage
- `rate-limit.db` — local rate-limit persistence
- `documents/` — generated documents
- `screenshots/` — screenshot output from tools
- `qdrant-storage/` — local vector storage/runtime files

If you want a clean local reset, the usual targets are:

- `backend/data/chat.db`
- `backend/data/chat.db-shm`
- `backend/data/chat.db-wal`
- `backend/data/memory.db`
- `backend/data/memory.db-shm`
- `backend/data/memory.db-wal`

Stop the backend before deleting SQLite files.

## Persistent ops/runtime data in 0.2.0

For the 0.2.0 ops release, the SQLite file from `STORAGE_MEMORY_DB_FILE` is release-critical even when `STORAGE_DRIVER=postgres`.

Why:

- chat and managed-memory repositories follow `STORAGE_DRIVER`
- cron, monitor state, Telegram monitored chats, outbound audit, and pending notify routing still persist in the SQLite runtime DB

Operational rule:

- back up `STORAGE_MEMORY_DB_FILE`
- back up `STORAGE_MEMORY_DB_FILE-wal`
- back up `STORAGE_MEMORY_DB_FILE-shm`

Boot-time repository initialization applies additive/idempotent migrations for 0.2.0, including:

- `tg_client_chats.chat_type`
- `cron_jobs.notification_policy`
- `cron_job_runs.result_status`
- `cron_job_runs.notification_status`
- `cron_job_runs.notification_error_message`

See `docs/release-0.2.0.md` for the exact rollout, smoke-check, and rollback procedure.

## Runtime hardening and diagnostics in 0.2.3

0.2.3 adds a stricter runtime contract for startup hygiene, prompt budgeting, continuation state, and operator diagnostics.

Operationally important points:

- `/api/ops/diagnostics` is now the authoritative operator surface for runtime health, LLM profile, soul source metadata, managed-memory processing state, prompt diagnostics, continuation checkpoints, Qdrant readiness, and actionable warnings
- `SOUL_CONFIG_PATH` is now operationally visible through `source`, `sourceKind`, and `configuredPath`
- `TELEGRAM_ENABLED` is the first gate for Telegram inbound auth and bot lifecycle behavior
- AppleScript exposes capability state (`available`, `disabled`, `unsupported_os`) instead of relying on noisy unsupported-host warnings
- prompt trimming, compression, and high budget pressure are expected runtime signals and should be reviewed in the ops runtime tab instead of treated as hidden implementation detail
- continuation checkpoints are release-critical execution state and must survive the selected `storage.driver`

Before rollout or rollback for 0.2.3, preserve:

- `STORAGE_MEMORY_DB_FILE` and its sidecars for ops/runtime SQLite state
- the active `SOUL_CONFIG_PATH` target, if used
- the selected chat/memory/execution-state storage backend for the configured `STORAGE_DRIVER`

See `docs/release-0.2.3.md` for the exact rollout, smoke-check, and rollback procedure.

## Docker Compose

`docker-compose.yml` defines these services:

- `postgres`
- `redis`
- `qdrant`
- `backend`
- `frontend`

Compose defaults:

- backend on `http://localhost:3000`
- frontend on `http://localhost:8080`
- qdrant on `http://localhost:6333`
- backend uses `NODE_ENV=production`
- backend uses `STORAGE_DRIVER=postgres`
- backend uses `RATE_LIMIT_BACKEND=redis`
- backend enables semantic memory through local embeddings + Qdrant
- backend accepts API keys and can fall back to public sessions for browser mode
- backend trusts one reverse-proxy hop with `TRUST_PROXY_HOPS=1`
- backend points local-style LLM traffic to `http://host.docker.internal:8317/v1`
- compose includes healthchecks for `postgres`, `redis`, `backend`, and `frontend`

Frontend container notes:

- frontend is built separately from backend
- frontend receives `API_KEY` and `ADMIN_API_KEY` from Compose environment
- `/api` traffic is proxied to the backend container
- browser-mode requests also work without injected API keys when public sessions are enabled

## Testing and verification

From the project root:

```bash
npm run verify
```

This runs:

- CLI tests
- backend unit tests
- backend e2e tests
- frontend tests

Individual commands:

```bash
npm run test:cli
npm run test:backend
npm run test:backend:e2e
npm run test:frontend
```

Manual lint/build commands:

```bash
npm run lint --prefix backend
npm run build --prefix backend
npm run lint --prefix frontend
npm run build --prefix frontend
```

## Operational notes

- In production-like setups, backend auth should be enabled.
- If public sessions are used, set `AUTH_PUBLIC_SESSION_SECRET`.
- If settings store secrets through the Settings API, set `SETTINGS_ENCRYPTION_SECRET`.
- Embedding-based semantic recall only works when embeddings are enabled and Qdrant is available.
- In local HTTP setups, public-session cookies only become `Secure` when the request is actually behind HTTPS.
- Telegram bot and Telegram client are optional and disabled unless configured.

## What to update when operations change

Update this document if you change:

- root CLI workflow
- default local ports
- env variable surface
- data file locations
- Docker runtime defaults
- reset procedure for local state
