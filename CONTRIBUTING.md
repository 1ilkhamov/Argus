# Contributing to Argus

Спасибо за интерес к проекту.

Этот репозиторий объединяет CLI, backend, frontend и документацию, поэтому даже небольшие изменения лучше делать осознанно и с пониманием того, какой слой вы затрагиваете.

## Что важно перед началом

- Используйте **Node.js 22+**.
- Считайте код источником истины, если документация и реализация расходятся.
- Не коммитьте `.env`, runtime-данные из `backend/data/`, локальные ключи и секреты.
- Если изменение меняет поведение runtime, API, env surface или docs navigation, обновите соответствующую документацию.

## Структура проекта

- `cli/` — onboarding, doctor-checks, локальный start flow
- `backend/` — NestJS backend, chat runtime, memory, tools, Telegram, auth
- `frontend/` — React/Vite UI
- `docs/` — поддерживаемая документация

## Рекомендуемый локальный workflow

```bash
npm install
npm run onboard
npm run doctor
npm run start
```

## Ручной запуск для разработки

### Backend

```bash
cd backend
npm install
cp .env.example .env
npm run start:dev
```

### Frontend

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```

## Тесты

Полная проверка из корня проекта:

```bash
npm run verify
```

Отдельные команды:

```bash
npm run test:cli
npm run test:backend
npm run test:backend:e2e
npm run test:frontend
```

## Lint и build

```bash
npm run lint --prefix backend
npm run build --prefix backend
npm run lint --prefix frontend
npm run build --prefix frontend
```

## Ожидания к pull request

Перед открытием PR убедитесь, что:

- изменение имеет чёткую цель
- описание PR объясняет, **что** изменилось и **зачем**
- тесты проходят
- документация обновлена, если это нужно
- env surface не ломает текущий onboarding
- не добавлены случайные локальные файлы, runtime data или секреты

## Если вы меняете backend

Обновите документацию, если меняется хотя бы одно из следующего:

- top-level модули в `backend/src/app.module.ts`
- API routes
- tool categories или tool behavior
- auth / public session behavior
- storage defaults
- Telegram integration flow

## Если вы меняете frontend

Обновите документацию, если меняется хотя бы одно из следующего:

- основные UI-секции
- config surface в `frontend/.env.example`
- структура `src/api`, `src/stores`, `src/components`
- привязка к backend endpoints

## Если вы меняете документацию

Документация должна:

- опираться на реальный код и текущие конфиги
- не содержать устаревших планов, аудитов и временных заметок в core docs
- оставаться короткой и поддерживаемой

## Стиль изменений

- Делайте изменения точечно.
- Не смешивайте рефакторинг, feature work и массовую чистку в одном PR без причины.
- Если изменение большое, разбивайте его на понятные шаги.
- Если поведение спорное или рискованное, документируйте инварианты и ограничения в описании PR.

## Вопросы и обсуждение

Для обычных багов и feature-запросов используйте GitHub Issues.

Для security-вопросов не используйте публичные issues. См. `SECURITY.md`.
