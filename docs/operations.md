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

## Docker Compose

`docker-compose.yml` defines these services:

- `postgres`
- `redis`
- `backend`
- `frontend`

Compose defaults:

- backend on `http://localhost:3000`
- frontend on `http://localhost:8080`
- backend uses `NODE_ENV=production`
- backend uses `STORAGE_DRIVER=postgres`
- backend uses `RATE_LIMIT_BACKEND=redis`
- backend expects auth to be enabled
- backend points local-style LLM traffic to `http://host.docker.internal:8317/v1`

Frontend container notes:

- frontend is built separately from backend
- frontend receives `API_KEY` and `ADMIN_API_KEY` from Compose environment
- `/api` traffic is proxied to the backend container

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
- Telegram bot and Telegram client are optional and disabled unless configured.

## What to update when operations change

Update this document if you change:

- root CLI workflow
- default local ports
- env variable surface
- data file locations
- Docker runtime defaults
- reset procedure for local state
