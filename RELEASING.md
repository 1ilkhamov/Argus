# Releasing Argus

Этот файл описывает базовый процесс подготовки публичного GitHub release.

## Перед релизом

Проверьте следующее:

- README отражает текущее состояние проекта
- `docs/` синхронизированы с кодом
- `backend/.env.example` и `frontend/.env.example` актуальны
- `CHANGELOG.md` обновлён
- нет случайных локальных файлов, runtime data и секретов
- CI зелёный

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

- backend стартует локально
- frontend стартует локально
- health endpoint отвечает
- auth-путь работает
- env examples достаточно полны для нового пользователя

### 3. Проверка качества

- unit/e2e/frontend tests проходят
- lint проходит
- build проходит
- CI workflow валиден

### 4. GitHub release

Когда репозиторий уже опубликован на GitHub:

- создайте tag версии
- создайте GitHub Release
- используйте `CHANGELOG.md` и diff как основу release notes
- укажите breaking changes, если они есть

## Версионирование

Актуальная версия всегда фиксируется в корневых `package.json` и `package-lock.json`.

Рекомендуется:

- фиксировать заметные изменения в `CHANGELOG.md`
- синхронизировать версию в `package.json` и `package-lock.json` до публикации тега
- увеличивать версию осознанно
- не смешивать инфраструктурные правки, runtime changes и product-level changes без заметок в changelog
