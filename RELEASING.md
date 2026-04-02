# Releasing Argus

Этот файл описывает базовый процесс подготовки публичного GitHub release.

## Перед релизом

Проверьте следующее:

- README отражает текущее состояние проекта
- `docs/` синхронизированы с кодом
- если релиз требует version-specific runbook, он создан и указан в `docs/`
- `backend/.env.example` и `frontend/.env.example` актуальны
- `CHANGELOG.md` обновлён
- нет случайных локальных файлов, runtime data и секретов
- CI зелёный
- `docker compose config` проходит без ручных правок

## Локальная проверка

Из корня проекта:

```bash
npm install
npm run verify
```

Дополнительно можно проверить ручной локальный запуск:

```bash
npm run onboard
npm run doctor
npm run start
```

## Что проверить перед публикацией репозитория на GitHub

- есть `LICENSE`
- есть `README.md`
- есть `CONTRIBUTING.md`
- есть `SECURITY.md`
- есть `CODE_OF_CONDUCT.md`
- настроены GitHub Issues / PR templates
- включены branch protection rules
- включён GitHub Actions CI
- включён Dependabot
- включён GitHub Private Vulnerability Reporting

## Релизный чеклист

### 1. Подготовка содержимого

- обновить README
- обновить changelog
- проверить docs
- проверить public-facing формулировки

### 2. Проверка runtime

- сделан backup release-critical данных, включая `STORAGE_MEMORY_DB_FILE` и его `-wal` / `-shm` sidecars
- сохранён active soul override, если используется `SOUL_CONFIG_PATH`
- backend стартует локально
- frontend стартует локально
- health endpoint отвечает
- `/api/ops/diagnostics` отвечает и отражает ожидаемые `soul`, `startup`, `prompt`, `continuation` и `warnings`
- auth-путь работает
- `TELEGRAM_ENABLED` / `TELEGRAM_ALLOWED_USERS` ведут себя ожидаемо для целевого окружения
- OS-specific tools отражают capability state production-safe образом
- browser mode через public sessions работает без скрытой proxy-магии
- semantic memory путь работает с embeddings + Qdrant
- env examples достаточно полны для нового пользователя
- version-specific smoke checks пройдены, если для релиза есть отдельный runbook

### 3. Проверка качества

- unit/e2e/frontend tests проходят
- lint проходит
- build проходит
- CI workflow валиден
- smoke checks покрывают API-key auth, public-session flow и version-specific runtime diagnostics

### 4. GitHub release

Когда репозиторий уже опубликован на GitHub:

- создайте tag версии
- создайте GitHub Release
- используйте `CHANGELOG.md` и diff как основу release notes
- если релиз содержит отдельный runbook, приложите ссылку на него в release notes
- укажите breaking changes, если они есть

## Version-specific runbooks

- `docs/release-0.2.0.md` — migration story, smoke checks и rollback notes для ops/runtime release `0.2.0`
- `docs/release-0.2.3.md` — runtime hardening, diagnostics, continuation state, startup/config semantics и rollback notes для release `0.2.3`

## Версионирование

Актуальная версия всегда фиксируется в корневых `package.json` и `package-lock.json`.

Рекомендуется:

- фиксировать заметные изменения в `CHANGELOG.md`
- синхронизировать версию в `package.json` и `package-lock.json` до публикации тега
- увеличивать версию осознанно
- не смешивать инфраструктурные правки, runtime changes и product-level changes без заметок в changelog
