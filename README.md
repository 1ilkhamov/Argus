# Argus

<p align="center">
  <strong>Local-first AI workspace для чата, памяти, инструментов, Telegram и настраиваемой identity-модели агента.</strong>
</p>

<p align="center">
  Argus объединяет root CLI, NestJS backend и React/Vite frontend в один локальный AI workspace, который можно поднять из корня проекта и дальше развивать как цельную систему.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-22%2B-339933?logo=node.js&logoColor=white" alt="Node 22+" />
  <img src="https://img.shields.io/badge/Backend-NestJS%2011-E0234E?logo=nestjs&logoColor=white" alt="NestJS 11" />
  <img src="https://img.shields.io/badge/Frontend-React%2018%20%2B%20Vite%206-61DAFB?logo=react&logoColor=white" alt="React 18 and Vite 6" />
  <img src="https://img.shields.io/badge/Storage-SQLite%20%2F%20Postgres-336791?logo=postgresql&logoColor=white" alt="SQLite and Postgres" />
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" />
</p>

<p align="center">
  <a href="./docs/README.md">Документация</a> •
  <a href="./docs/operations.md">Запуск</a> •
  <a href="./docs/backend.md">Backend</a> •
  <a href="./docs/frontend.md">Frontend</a> •
  <a href="./docs/soul-customization.md">Soul Config</a>
</p>

## Быстрый старт (TL;DR)

### Рекомендуемый быстрый старт на новой машине

```bash
npm install -g argus-one
argus-one init
cd Argus
argus-one onboard
argus-one start
```

### Альтернатива для локальной разработки из репозитория

```bash
npm install
npm run onboard
npm run doctor
npm run start
```

После этого по умолчанию:

- frontend будет доступен на `http://localhost:2101`
- backend будет доступен на `http://localhost:2901`
- health endpoint backend: `http://localhost:2901/api/health`

## Почему Argus

- **Local-first по умолчанию**
  - проект ориентирован на локальный запуск и локальные defaults без обязательной облачной инфраструктуры

- **Одна система, а не набор разрозненных скриптов**
  - CLI, backend и frontend живут в одном репозитории и поддерживают один и тот же runtime workflow

- **Память и инструменты — first-class части runtime**
  - Argus не ограничивается чатом: в проект встроены memory layer, tool orchestration и safety policy

- **Telegram встроен в архитектуру, а не добавлен поверх**
  - поддерживаются Telegram bot и Telegram client режимы

- **Поведение агента можно настраивать отдельно от кода**
  - soul config позволяет менять базовую identity и стиль без переписывания backend-логики

## Что есть в проекте

| Компонент | Назначение | Путь |
|---|---|---|
| CLI | Onboarding, doctor-checks, локальный start flow, опциональный запуск Qdrant | `cli/` |
| Backend | Основной API runtime, LLM orchestration, память, инструменты, Telegram, auth | `backend/` |
| Frontend | Пользовательский интерфейс для чата, памяти, инструментов и настроек | `frontend/` |
| Docs | Поддерживаемая документация проекта | `docs/` |

## Ключевые возможности

- **Чат и ответы**
  - обычные и потоковые ответы
  - история диалогов
  - voice-путь через backend chat API

- **Память**
  - capture и recall памяти
  - archive evidence retrieval
  - deterministic memory commands
  - опциональный semantic recall через embeddings + Qdrant

- **Инструменты**
  - реестр инструментов
  - orchestration loop
  - safety policy
  - built-in web, memory, system, compute, scheduling, automation, communication и orchestration tools

- **Настройки и доступ**
  - API key auth
  - optional public sessions через cookies
  - хранение настроек с optional encryption

- **Интеграции**
  - Telegram bot
  - Telegram client через MTProto user account
  - webhooks
  - email tool

- **Identity / soul слой**
  - YAML-конфигурация базового поведения агента
  - hot reload активного soul config файла

## Как это устроено

```text
Frontend (React/Vite)
        │
        ▼
Backend API (NestJS)
        │
        ├── LLM providers (local / OpenAI / Anthropic / Google)
        ├── Memory system
        ├── Tool orchestration
        ├── Settings + auth
        ├── Telegram bot
        └── Telegram client
```

## Поддерживаемые runtime-варианты

| Слой | Что поддерживается |
|---|---|
| LLM providers | `local`, `openai`, `anthropic`, `google` |
| Storage drivers | `sqlite`, `file`, `postgres` |
| Rate limit backends | `memory`, `sqlite`, `redis` |
| Каналы | frontend UI, Telegram bot, Telegram client |
| Semantic recall | embeddings + Qdrant (опционально) |

## Встроенные инструменты

Текущий набор built-in tools определяется `backend/src/tools/tools.module.ts`.

| Категория | Примеры |
|---|---|
| Web | `web_search`, `web_fetch`, `http_request`, browser tools |
| Memory | `memory_manage`, `knowledge_search` |
| System | `system_run`, `file_ops`, `clipboard`, `notify`, `vision`, `pdf_read`, `sql_query`, `applescript`, `process` |
| Compute | `calculator`, `code_exec`, `datetime`, `audio_transcribe`, `document_gen` |
| Scheduling | cron tools |
| Automation | webhook tools |
| Communication | `email` |
| Orchestration | sub-agent tools |

## Технологический стек

- **Backend**
  - NestJS 11
  - TypeScript
  - provider-aware интеграция с LLM
  - поддержка SQLite / file / PostgreSQL storage
  - optional Redis-backed rate limiting
  - optional Qdrant для vector recall

- **Frontend**
  - React 18
  - TypeScript
  - Vite 6
  - Tailwind CSS
  - Zustand

- **CLI**
  - Node.js
  - интерактивный onboarding и локальный запуск workspace

- **Тестирование**
  - Node test runner для CLI
  - Jest для backend unit и e2e
  - Vitest для frontend
  - ESLint для backend и frontend

## Структура репозитория

```text
Argus/
├── backend/    # NestJS API, chat runtime, memory, tools, Telegram integrations
├── cli/        # argus-one CLI: onboard, doctor, start
├── docs/       # Поддерживаемая документация проекта
├── frontend/   # React/Vite UI
├── docker-compose.yml
├── package.json
└── README.md
```

## Root CLI workflow

### Рекомендуемый workflow через опубликованный CLI

```bash
npm install -g argus-one
argus-one init          # клонирует репозиторий Argus в ./Argus
cd Argus
argus-one onboard
argus-one doctor
argus-one start
```

- `argus-one init [--dir=<name>]`
- `argus-one onboard`
- `argus-one doctor`
- `argus-one start`
- `argus-one --help`

### Альтернативный workflow из репозитория

- `npm run onboard`
- `npm run doctor`
- `npm run start`
- `npm run help`
- `npm run verify`

### Что делает `onboard`

- создаёт или обновляет `backend/.env` и `frontend/.env`
- валидирует локальное окружение
- настраивает flow выбора LLM provider
- устанавливает зависимости, если это нужно
- может подготовить workspace для опционального использования Qdrant

### Что делает `doctor`

- проверяет версию Node.js
- проверяет наличие env-файлов
- проверяет установку зависимостей
- проверяет занятость портов frontend и backend
- проверяет доступность сервисов, если они уже запущены

### Что делает `start`

- запускает Qdrant, если он установлен и ещё не работает
- запускает backend, если он ещё не работает
- запускает frontend, если он ещё не работает
- использует backend port из `backend/.env`

## Локальные значения по умолчанию

Значения по умолчанию определены в `backend/src/config/defaults.ts` и `frontend/vite.config.ts`.

| Runtime value | Значение по умолчанию |
|---|---|
| Backend URL | `http://localhost:2901` |
| Frontend URL | `http://localhost:2101` |
| Backend API prefix | `/api` |
| Frontend dev proxy target | `http://localhost:2901` |
| LLM provider по умолчанию | `local` |
| Local LLM API base по умолчанию | `http://localhost:8317/v1` |

Provider-aware LLM defaults:

- `local` → `LLM_API_BASE=http://localhost:8317/v1`, `LLM_MODEL=local-model`
- `openai` → `LLM_API_BASE=https://api.openai.com/v1`, `LLM_MODEL=gpt-5-mini`
- `anthropic` → `LLM_API_BASE=https://api.anthropic.com/v1`, `LLM_MODEL=claude-sonnet-4-6`
- `google` → `LLM_API_BASE=https://generativelanguage.googleapis.com/v1beta`, `LLM_MODEL=gemini-2.5-flash`

## Ручная разработка

Корневой CLI — рекомендуемый способ запуска, но ручной backend/frontend workflow тоже полностью поддерживается.

### Backend

```bash
cd backend
npm install
cp .env.example .env
npm run start:dev
```

Локальный backend URL по умолчанию:

- `http://localhost:2901`

Health endpoint:

- `http://localhost:2901/api/health`

### Frontend

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```

Локальный frontend URL по умолчанию:

- `http://localhost:2101`

Поведение dev proxy:

- frontend проксирует `/api` на `VITE_DEV_PROXY_TARGET`
- target по умолчанию — `http://localhost:2901`
- если в `frontend/.env` задан `API_KEY`, proxy добавляет `X-API-Key`

## Backend в двух словах

### Основные модули

`backend/src/app.module.ts` подключает следующие top-level модули:

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

### Основные backend-домены

| Домен | Что делает |
|---|---|
| Chat | lifecycle диалогов, turn preparation, streaming, validation, tool-aware completion |
| Memory | memory CRUD, recall, archive evidence, lifecycle, optional semantic layer |
| Tools | registry, execution, orchestration, safety policy |
| Settings/Auth | runtime settings API, API keys, public sessions, settings encryption |
| Telegram | bot integration и Telegram client через пользовательский аккаунт |

### Основные группы API

Все backend routes обслуживаются под глобальным префиксом `/api`.

- `/api/health`
- `/api/chat/*`
- `/api/memory/v2/*`
- `/api/settings/*`
- `/api/tools`
- `/api/telegram/*`
- `/api/telegram-client/*`
- `/api/hooks/:name`

## Frontend в двух словах

Текущий frontend в `frontend/` предоставляет четыре основные UI-секции:

| UI-секция | Назначение |
|---|---|
| Chat | основной интерфейс общения с агентом, история, streaming |
| Settings | runtime-настройки и интеграции |
| Memory | просмотр и управление памятью |
| Tools | видимость доступных инструментов и связанных surface'ов |

Ключевые frontend-директории:

- `src/api`
- `src/components`
- `src/config`
- `src/hooks`
- `src/i18n`
- `src/stores`
- `src/styles`
- `src/types`

## Безопасность и контроль

Argus уже содержит несколько встроенных механизмов контроля runtime-поведения:

- **Tool safety policy**
  - режимы `permissive`, `standard`, `strict`
  - allowlist/blocklist для инструментов

- **Auth**
  - API keys
  - отдельный admin API key
  - optional public sessions через cookies

- **Настройки и секреты**
  - runtime settings API
  - optional encryption через `SETTINGS_ENCRYPTION_SECRET`

- **HTTP/runtime safety**
  - trusted proxy hops
  - rate limiting
  - global validation и exception handling

## Конфигурация

### Конфигурация backend

Backend env-файлы:

- активный файл: `backend/.env`
- шаблон: `backend/.env.example`

Основные группы конфигурации:

- server
- настройки LLM provider и model
- auth и public sessions
- rate limiting
- storage
- embeddings и Qdrant
- tool settings
- Telegram bot
- Telegram client
- hooks
- settings encryption
- путь к soul override

### Конфигурация frontend

Frontend env-файлы:

- активный файл: `frontend/.env`
- шаблон: `frontend/.env.example`

Текущая frontend env surface:

- `VITE_API_BASE`
- `VITE_DEV_PROXY_TARGET`
- `API_KEY`
- `ADMIN_API_KEY`

## Локальные данные

Локальные runtime-данные по умолчанию лежат в `backend/data/`.

Основные файлы и директории:

- `chat.db` — диалоги и история чата
- `memory.db` — память агента
- `rate-limit.db` — локальное хранилище rate limit
- `documents/` — сгенерированные документы
- `screenshots/` — скриншоты, созданные инструментами
- `qdrant-storage/` — локальные vector/runtime данные

## Docker Compose

`docker-compose.yml` поднимает следующие сервисы:

- `postgres`
- `redis`
- `backend`
- `frontend`

Значения по умолчанию в Compose:

- backend на `http://localhost:3000`
- frontend на `http://localhost:8080`
- backend запускается в `production` mode
- backend использует `STORAGE_DRIVER=postgres`
- backend использует `RATE_LIMIT_BACKEND=redis`
- backend ожидает, что auth включён
- backend направляет local-style LLM трафик на `http://host.docker.internal:8317/v1`

## Тесты и проверка

Запуск всех test suites из корня проекта:

```bash
npm run verify
```

Эта команда запускает:

- CLI tests
- backend unit tests
- backend e2e tests
- frontend tests

Отдельные команды:

```bash
npm run test:cli
npm run test:backend
npm run test:backend:e2e
npm run test:frontend
```

Lint и build:

```bash
npm run lint --prefix backend
npm run build --prefix backend
npm run lint --prefix frontend
npm run build --prefix frontend
```

## Настройка soul / identity

Argus поддерживает опциональный YAML soul config для базовой identity и поведения агента.

Быстрый старт:

```bash
cp backend/src/agent/identity/config/soul.default.yml backend/data/soul.yml
```

Backend загружает первый валидный soul config в таком порядке:

1. `SOUL_CONFIG_PATH`
2. `backend/data/soul.yml`
3. bundled default config
4. internal fallback

Подробности по формату и поведению — в `docs/soul-customization.md`.

## Документация

Поддерживаемая документация проекта находится в `docs/`.

- `docs/README.md` — индекс документации
- `docs/backend.md` — архитектура и runtime surface backend
- `docs/frontend.md` — структура и runtime behavior frontend
- `docs/operations.md` — setup, env files, Docker, testing, local data
- `docs/soul-customization.md` — загрузка и настройка soul config

## Contribution, support и release management

Public-facing repo файлы:

- `CONTRIBUTING.md` — как вносить изменения и что проверять перед PR
- `CODE_OF_CONDUCT.md` — правила поведения в проекте
- `SECURITY.md` — как репортить security issues
- `SUPPORT.md` — куда смотреть перед открытием issue
- `CHANGELOG.md` — заметные изменения проекта
- `RELEASING.md` — чеклист подготовки GitHub release

Если README или docs расходятся с кодом, ориентируйся на код как на source of truth.
