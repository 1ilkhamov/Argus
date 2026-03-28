# Security Policy

## Supported versions

На текущий момент активно поддерживается следующая линия версий:

| Version | Supported |
|---|---|
| `0.1.x` | Yes |
| `< 0.1.0` | No |

## Reporting a vulnerability

Не публикуйте security issues в публичных GitHub issues.

Если для репозитория включён **GitHub Private Vulnerability Reporting**, используйте именно его.

Если private reporting ещё не включён:

- не раскрывайте уязвимость публично
- свяжитесь с владельцем репозитория приватно через доступный канал связи до публичного disclosure
- дайте время на подтверждение, исправление и coordinated disclosure

## What to include in a report

По возможности приложите:

- краткое описание проблемы
- затронутый компонент
- шаги для воспроизведения
- ожидаемое и фактическое поведение
- потенциальный impact
- proof of concept, если он безопасен для передачи
- версию или commit, если они известны

## Scope examples

Особенно важны отчёты, связанные с:

- auth bypass
- утечкой секретов
- небезопасным выполнением tool actions
- SSRF / command execution / file access beyond expected boundaries
- Telegram / webhook surfaces
- settings encryption и secret storage
- public session security

## Disclosure expectations

До выхода исправления:

- не публикуйте exploit details
- не открывайте публичный issue с рабочим сценарием атаки
- не включайте в отчёт реальные секреты, токены или персональные данные

## Response target

Проект стремится:

- подтвердить получение отчёта в разумный срок
- воспроизвести проблему
- определить severity и область влияния
- подготовить исправление и release notes

## Hardening note

Перед публичным релизом репозитория рекомендуется включить:

- GitHub Private Vulnerability Reporting
- branch protection rules
- required CI checks
- secret scanning и Dependabot alerts
