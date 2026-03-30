# Changelog

Все заметные изменения проекта должны фиксироваться в этом файле.

Формат вдохновлён [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), а семантика версий — [Semantic Versioning](https://semver.org/).

## [Unreleased]

- Пока без изменений.

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
