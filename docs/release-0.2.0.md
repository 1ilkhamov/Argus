# Argus 0.2.0 release runbook

## Purpose

This document closes the 0.2.0 release gates that are specific to operations visibility, Telegram monitored chats, outbound audit, and persistent runtime state.

Use it together with `RELEASING.md`.

## Scope of 0.2.0

0.2.0 is the release where Argus gets a production-grade admin operations surface:

- unified frontend ops console for logs, monitors, Telegram runtime, cron, notify routing, structured ops events, and outbound audit
- edit UX for monitored Telegram chats: `mode`, `cooldownSeconds`, `systemNote`
- richer log, event, and outbound audit filtering by time range and structured IDs
- detailed decision visibility for outbound routing and policy outcomes
- explicit release notes for persistent ops/runtime storage and rollback

## Persistent data and migration story

### Storage split in 0.2.0

There are two different persistence paths in this release:

- `STORAGE_DRIVER=sqlite|file|postgres` controls chat and managed-memory repositories from `backend/src/storage/storage.module.ts`
- ops/runtime persistence for cron, monitors, Telegram client monitored chats, outbound audit, and pending notify routing still uses the SQLite file from `STORAGE_MEMORY_DB_FILE`

That means **even in PostgreSQL deployments** you still need to treat `STORAGE_MEMORY_DB_FILE` as release-critical state for 0.2.0 ops/runtime data.

### SQLite file that must be backed up

Before rollout, back up:

- `STORAGE_MEMORY_DB_FILE`
- companion WAL files if they exist: `*.db-wal`, `*.db-shm`

Typical local/default targets:

- `backend/data/memory.db`
- `backend/data/memory.db-wal`
- `backend/data/memory.db-shm`

If `STORAGE_DRIVER=postgres`, also back up PostgreSQL in the usual way for chat/memory data.

### What migrates automatically on boot

0.2.0 relies on idempotent repository boot-time schema initialization and additive migrations.

#### Telegram client monitored chats

Repository: `backend/src/telegram-client/telegram-client.repository.ts`

- creates `tg_client_chats` if missing
- adds `chat_type` for existing databases with `ALTER TABLE ... ADD COLUMN`

#### Cron jobs

Repository: `backend/src/cron/cron-job.repository.ts`

- creates `cron_jobs` if missing
- adds `notification_policy` for existing databases

#### Cron runs

Repository: `backend/src/cron/cron-run.repository.ts`

- creates `cron_job_runs` if missing
- adds `result_status`
- adds `notification_status`
- adds `notification_error_message`
- normalizes legacy statuses:
  - `succeeded -> notified/success/sent`
  - `dropped -> canceled/canceled/skipped`

#### Monitor state

Repository: `backend/src/monitors/monitor.repository.ts`

- creates monitor rules/state/evaluations/alerts tables if missing
- uses additive table creation and upserts for runtime state

#### Notify routing

Repository: `backend/src/tools/core/pending-notify.repository.ts`

- creates pending message, awaiting reply, and reply route tables if missing
- stores expirations and route completion history in the same SQLite runtime DB

#### Outbound audit

Repository: `backend/src/telegram-runtime/telegram-outbound-audit.repository.ts`

- creates `tg_outbound_events` if missing
- creates indexes for `created_at`, `target_chat_id`, `origin`, `correlation_id`, `result`, and `policy_decision`

### PostgreSQL note

`backend/src/storage/postgres-connection.service.ts` already contains migration and legacy import logic for chat/memory data.

That logic does **not** replace the SQLite ops/runtime repositories in 0.2.0.

Operational consequence:

- PostgreSQL rollout alone is not enough for this release
- the SQLite runtime DB must travel with the deployment or be restored from backup
- do not assume outbound audit / monitor state / cron history lives in PostgreSQL unless the code is explicitly changed in a later release

### Safe rollout sequence

1. Stop the backend or quiesce writes.
2. Back up `STORAGE_MEMORY_DB_FILE` and WAL/SHM sidecars.
3. Back up PostgreSQL too if `STORAGE_DRIVER=postgres`.
4. Deploy the new backend artifact.
5. Start the backend once and let repositories initialize/migrate.
6. Verify `/api/health`.
7. Verify ops data surfaces before resuming normal operator activity.

## 0.2.0 smoke checks

### Backend/API

Run these after deploy:

- `GET /api/health` returns `ok`
- admin auth still protects ops routes
- `GET /api/logs/search` returns filtered entries
- `GET /api/monitors/rules`, `/api/monitors/states`, `/api/monitors/evaluations`, `/api/monitors/alerts` respond
- `GET /api/telegram-client/runtime` and `GET /api/telegram-client/monitored-chats` respond
- `PATCH /api/telegram-client/monitored-chats/:id` updates `mode`, `cooldownSeconds`, `systemNote`
- `GET /api/cron/jobs` and `GET /api/cron/runs` respond
- `GET /api/notify/routing` responds
- `GET /api/ops/events` accepts `kind`, `correlationId`, `chatId`, `jobId`, `ruleId`, `after`, `before`
- `GET /api/telegram-outbound-audit` accepts `actor`, `origin`, `result`, `policyDecision`, `chatId`, `correlationId`, `after`, `before`

### Frontend/admin UX

Open the ops page and verify:

- logs tab filters by level/file/date and structured IDs
- runtime tab can edit a monitored chat and the saved state rehydrates runtime data
- audit tab shows decision reason, monitored mode, conversation ID, and target chat details
- events tab filters by time range and correlation/chat/job/rule IDs
- notify tab shows pending messages, awaiting replies, and recent routes
- cron and monitor tabs still support their existing write/control flows

### Targeted verification already run locally

The following commands were used as 0.2.0 frontend verification:

- `frontend`: `npm run build`
- `frontend`: `npm run lint`
- `frontend`: `npm run test -- src/stores/ops/ops.store.test.ts`

Recommended backend verification for release sign-off:

- `backend`: `npm run build`
- `backend`: `npm run lint`
- `backend`: `npm run test:e2e -- --runInBand test/e2e/ops-admin.e2e-spec.ts`

## Rollback notes

### Rollback rule

For rollback from 0.2.0 to an older artifact, **restore the pre-upgrade SQLite runtime backup** instead of relying on in-place schema compatibility.

Reason:

- 0.2.0 adds and normalizes ops/runtime persistence fields
- additive columns are usually harmless, but semantic rollback is not guaranteed once new statuses and new audit/runtime data have been written
- backup/restore is the safest way to prevent hidden drift between code expectations and persisted runtime state

### Recommended rollback procedure

1. Stop the backend.
2. Redeploy the previous application artifact.
3. Restore the pre-0.2.0 `STORAGE_MEMORY_DB_FILE` backup and WAL/SHM sidecars.
4. Restore PostgreSQL backup too if the deployment changed PostgreSQL-backed chat/memory data and you need full point-in-time parity.
5. Start the backend.
6. Re-run `/api/health`.
7. Re-check admin ops routes and Telegram runtime.

### What not to do

Do not:

- downgrade the binary while keeping newly written 0.2.0 runtime state without validation
- assume PostgreSQL contains ops/runtime state in this release
- delete the runtime SQLite DB as a rollback shortcut unless data loss is acceptable

## Release-owner sign-off checklist

Mark 0.2.0 ready only when all of the following are true:

- migration backups were taken
- frontend ops console verification is green
- backend targeted verification is green
- smoke checks passed in the target environment
- rollback backup is stored and tested procedurally
- `CHANGELOG.md` and `RELEASING.md` reflect the final release state
