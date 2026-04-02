# Changelog

Все заметные изменения проекта должны фиксироваться в этом файле.

Формат вдохновлён [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), а семантика версий — [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.3] - 2026-04-02

### Added

- Added persistent turn-execution planning/runtime services so chat turns can carry budget snapshots, active continuation checkpoints, and staged execution metadata across requests
- Added deterministic exact-first managed-memory mutation semantics in `backend/src/memory/conversational-memory-command.service.ts`, including ambiguity-safe fact/episodic mutations and richer snapshot inspection output
- Added unified bootstrap/runtime diagnostics in `backend/src/ops/bootstrap-diagnostics.service.ts` and `/api/ops/diagnostics`, covering health, LLM runtime, soul config source, startup storage/Telegram/AppleScript state, managed-memory processing state, prompt diagnostics, continuation checkpoints, Qdrant readiness, and actionable warnings
- Added unified diagnostics cards, warnings, and continuation visibility to `frontend/src/components/ops/OpsConsoleV2.tsx` through a typed `ops.store` diagnostics slice
- Added version-specific release runbook `docs/release-0.2.3.md` for runtime hardening, smoke checks, and rollback expectations

### Changed

- Refactored `backend/src/chat/chat.service.ts` around prompt assembly, budget diagnostics, staged execution planning, and checkpoint-aware continuation handling for large tasks
- Tightened `backend/src/chat/runtime/prompt-budget.service.ts` and `backend/src/llm/llm.service.ts` so prompt diagnostics now expose explicit completion/retry/tool-round/structured-finish reserves and classify context-window exhaustion as `budget_exhausted`
- Hardened startup/config behavior so soul config runtime state now reports `sourceKind` and `configuredPath`, Telegram runtime fully respects `TELEGRAM_ENABLED`, and AppleScript exposes OS-aware capability semantics instead of noisy unsupported-host warnings
- Updated frontend ops API/store contracts and runtime tab UX to treat `/api/ops/diagnostics` as the authoritative operator surface for prompt, continuation, startup, monitored-chat, and Telegram runtime diagnostics
- Synced release metadata and documentation to the 0.2.3 runtime contract, including `RELEASING.md`, `docs/operations.md`, and `docs/README.md`

### Verified

- `backend`: `npm run build`
- `backend`: `npx jest --runInBand src/telegram/auth/telegram.auth.service.spec.ts src/telegram/bot/telegram.service.spec.ts src/tools/builtin/system/applescript.tool.spec.ts`
- `backend`: `npx jest --config ./test/jest-e2e.json --runInBand test/e2e/ops-admin.e2e-spec.ts`
- `frontend`: `npm run build`
- `frontend`: `npm run test -- src/stores/ops/ops.store.test.ts`

## [0.2.2] - 2026-04-01

### Added

- Added missing localized tool description entries in `frontend/src/i18n/locales/ru.json` and `frontend/src/i18n/locales/en.json` so the tools catalog no longer shows untranslated metadata for the newly exposed built-in tools

### Changed

- Refined `frontend/src/components/ops/OpsConsoleV2.tsx` to use cleaner shared page surfaces for filters, forms, sections and cards, aligning the operations page more closely with the rest of the frontend shell
- Improved operations page scanning UX with clearer status badges, more consistent block sizing and spacing, and a more readable outbound audit split-view
- Updated the runtime tab badge logic to reflect the actual monitored chat/runtime footprint instead of only `runtimeStates.length`

## [0.2.1] - 2026-03-31

### Fixed

- Stabilized `frontend/src/components/ops/OpsConsoleV2.tsx`: separated Zustand data selectors from action dispatchers so the ops auto-refresh no longer loops on every store update
- Improved ops page loading UX and layout so current tab content stays visible during refresh while the page keeps the common `Page*` shell structure

### Verified

- `frontend`: `npx eslint src/components/ops/OpsConsoleV2.tsx`
- `frontend`: `npx tsc --noEmit -p tsconfig.json`
- `frontend`: `npm run test -- src/stores/ops/ops.store.test.ts`

## [0.2.0] - 2026-03-31

### Added

- Unified admin ops console во frontend: tabs для logs, monitors, Telegram runtime, cron, notify routing, structured ops events и outbound audit
- CRUD/control flows для cron jobs и monitor rules, включая create/update/delete, pause/resume для cron и manual run для monitor rules
- Visibility по monitored chats, pending notify routing, awaiting replies и recent reply routes в ops dashboard
- Runtime edit UX для monitored Telegram chats: обновление `mode`, `cooldownSeconds` и `systemNote` прямо из ops console
- Aggregated structured operational events surface с фильтрацией по `kind`, `correlationId`, `chatId`, `jobId` и `ruleId`
- Targeted frontend store coverage для новых ops runtime/admin flows в `src/stores/ops/ops.store.test.ts`
- Version-specific release runbook `docs/release-0.2.0.md` с migration story, smoke checks и rollback notes

### Changed

- Frontend ops API/store contract расширен под notify routing, monitored chats, structured ops events и write/admin endpoints для cron и monitors
- App shell ops page теперь использует расширенный `OpsConsole` через barrel export без удаления fallback `OpsPanel`
- Ops UI локализации синхронизированы с новым console scope в `ru` и `en`
- Ops console добавляет richer filters по `after` / `before`, structured IDs и detail surfaces для outbound audit decision reasons
- Release docs уточняют, что ops/runtime persistence 0.2.0 всё ещё зависят от `STORAGE_MEMORY_DB_FILE` SQLite even with `STORAGE_DRIVER=postgres`

### Verified

- `frontend`: `npm run build`
- `frontend`: `npm run lint`
- `frontend`: `npm run test -- src/stores/ops/ops.store.test.ts`
- `backend`: `npm run build`
- `backend`: `npm run lint`
- `backend`: `npx jest --config ./test/jest-e2e.json --runInBand test/e2e/ops-admin.e2e-spec.ts`
- `root`: `npm run verify`

## [0.1.4]

### Fixed

- Убрана зависимость от скрытых runtime-правок: frontend memory scope, memory kinds, pinned counts и UUID fallback теперь зафиксированы в исходниках
- Исправлен self-hosted browser mode: public sessions теперь работают для chat и memory без скрытой proxy-магии
- Исправлена передача cookie credentials в frontend streaming HTTP client для SSE и form-data запросов
- Синхронизированы embeddings и Qdrant: runtime сам подхватывает фактическую размерность локальной embedding-модели
- Усилен runtime health: embeddings и Qdrant теперь различаются как `disabled` и `configured but down`
- Выровнены Docker/Compose runtime defaults, healthchecks и release-путь, чтобы уменьшить repo/server drift

## [0.1.3]

### Fixed

- Исправлена propagation `scopeKey` в managed memory runtime для conversational memory commands
- Возвращены локализованные ответы memory-команд и синхронизированы backend unit tests
- Убран stray `LOG undefined` в backend logger
- Восстановлена передача `X-API-Key` во frontend HTTP client для обычных, streaming и form-data запросов
- Добавлены регрессионные тесты для header propagation и conversational memory command behavior

## [0.1.2]

### Added

- Managed memory runtime: resolver, repositories, management service, persistence backends и metadata/audit flow
- User-fact и episodic-memory extraction / lifecycle / retrieval / commit infrastructure
- Conversational memory commands и расширенное тестовое покрытие deterministic memory operations
- Backend file logging в `data/logs`

### Changed

- `argus-one onboard` теперь может автоматически клонировать workspace и переиспользовать сохранённый путь для `start` и `doctor`
- Расширены response directives, compliance behavior и prompt assembly

## [0.1.1]

### Added

- Команда `argus-one init` для клонирования Argus в новый локальный workspace

### Changed

- Обновлены README, help output и quick-start flow вокруг CLI
- Укреплены CI smoke checks и добраны lint/type cleanup правки в release-потоке

## [0.1.0]

### Added

- Root CLI для onboarding, doctor-checks и локального запуска workspace
- NestJS backend с chat runtime, memory, tools, settings, auth и Telegram integrations
- React/Vite frontend для работы с чатом, памятью, инструментами и настройками
- Optional vector recall через embeddings + Qdrant
- YAML-based soul configuration с hot reload
- GitHub community health files, templates и release-support docs

### Changed

- README и core docs синхронизированы с текущей структурой проекта и runtime-поведением

### Notes

- Первый публичный baseline релиз проекта на GitHub.
