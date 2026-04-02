# Argus 0.2.3 release runbook

## Purpose

This document closes the 0.2.3 release gates that are specific to large-task runtime hardening, deterministic managed-memory mutations, startup/config hygiene, and unified operator diagnostics.

Use it together with `RELEASING.md`.

## Scope of 0.2.3

0.2.3 is the release where Argus hardens the current assistant runtime before 0.3.0 instead of opening a new product surface.

The release is specifically about these seven required packages:

- structured prompt assembly
- prompt budgeting and token governance
- staged execution and continuation checkpoints
- deterministic managed-memory commands
- memory diagnostics and ops visibility
- startup/config hygiene
- docs, verification, and release discipline

Operationally, that means:

- large tasks should stop depending on one flat best-effort prompt path
- prompt budgeting becomes an explicit runtime decision before every LLM call
- long turns can degrade into staged execution with persistent continuation state
- managed memory mutations become deterministic, exact-first, and ambiguity-safe
- the existing ops surface becomes the authoritative place to inspect runtime diagnostics

## What is explicitly not part of 0.2.3

This release does **not** introduce the 0.3.0 platform scope.

Out of scope:

- provider-based coding-agent runtime
- sandbox/worktree execution
- supervised diff/apply flow
- a new engineering console surface
- large conversation-storage redesign
- separate migration framework
- new major channel integrations
- platform changes that belong to `0.3.0`

## Runtime contract changes

### Prompt assembly, budget control, and large-task behavior

The 0.2.3 runtime no longer treats prompt construction as an opaque flat context blob.

Implemented release contract:

- prompt assembly is section-oriented instead of flat best-effort string concatenation
- token estimation is provider-aware and conservative
- prompt budgeting happens before each completion/stream request
- budget decisions now reserve tokens for:
  - the main completion
  - validator retry
  - tool-round execution
  - structured finish/finalization
- the runtime exposes explicit budget diagnostics instead of hiding budget pressure in logs

Expected operator-visible behavior:

- latest prompt diagnostics include provider/model, reserve buckets, available prompt tokens, trimmed sections, trimmed history, compressed sections, execution reasons, and budget pressure
- high-pressure prompt states surface as explicit runtime warnings
- a large task can degrade into staged execution instead of silently failing in one monolithic prompt/response pass
- timeout, abort, or budget exhaustion can create a continuation-ready partial result with a persistent checkpoint

Operational consequence:

- `/api/ops/diagnostics` is now the authoritative operator surface for prompt-budget, continuation-state, monitored-chat, and Telegram runtime visibility
- the staged execution model is now explicit: `analyze -> plan -> execute -> finalize`

### Deterministic managed memory mutation path

Managed memory commands in 0.2.3 are now exact-first, scope-aware, and conflict-safe.

Expected behavior in 0.2.3:

- exact match mutations succeed deterministically
- ambiguous matches produce a no-op response with explicit ambiguity details
- snapshot inspection exposes managed-memory versioning and `lastProcessedUserMessage`
- operator diagnostics surface managed-memory counts, pinned counts, and processing-state version metadata

Release consequence:

- memory mutation should no longer depend on fuzzy target guessing
- inspect flows should reflect the current managed-memory snapshot instead of partial runtime assumptions

### Startup, configuration hygiene, and runtime diagnostics

0.2.3 adds a stricter startup/runtime contract for environment and capability state:

- soul config runtime state now includes source, source kind, and configured path metadata
- `TELEGRAM_ENABLED=false` disables inbound auth and bot lifecycle cleanly
- empty Telegram allowlists are only treated as warnings when Telegram is actually enabled
- Telegram bot status exposes `enabled`, `tokenConfigured`, `tokenSource`, `running`, `username`, and `mode`
- AppleScript runtime state exposes `platform`, `supported`, `enabled`, `registered`, and `status`
- unsupported OS environments no longer raise AppleScript as an incident-style warning by default

## Release-critical configuration semantics

### Soul config resolution

The authoritative soul config candidates for this release are:

- explicit `SOUL_CONFIG_PATH`
- `backend/data/soul.yml`
- bundled `backend/soul.default.yml`
- source default fallback

Operator expectation:

- fallback to `core_contract_fallback` should be treated as a misconfiguration warning unless intentionally used in tests
- the startup log and `/api/ops/diagnostics` should expose both `source` and `sourceKind`

### Telegram gating

`TELEGRAM_ENABLED` is now the first gate for all inbound/bot behavior.

Expected semantics:

- when `TELEGRAM_ENABLED=false`, inbound Telegram auth rejects requests without implying an allowlist misconfiguration
- when `TELEGRAM_ENABLED=false`, bot startup/restart remains disabled even if a token exists in settings or env
- when `TELEGRAM_ENABLED=true`, token source precedence is `settings` over environment
- when `TELEGRAM_ENABLED=true` and no token exists, diagnostics should warn about a missing bot token
- when `TELEGRAM_ENABLED=true` and the allowlist is empty, diagnostics should warn about the empty allowlist

### OS-specific tool capability semantics

AppleScript is now treated as an OS-scoped capability rather than a universal failure mode.

Expected semantics:

- on macOS, `status=available` means the tool is enabled and registered
- on macOS, `status=disabled` means the host supports AppleScript but config disabled it
- on non-macOS hosts, `status=unsupported_os` is expected and should not page operators by itself

## Persistent state and rollout notes

### Storage split still matters

0.2.3 continues to use two persistence layers:

- `STORAGE_DRIVER=sqlite|file|postgres` for chat history, managed memory, and turn execution state via `backend/src/storage/storage.module.ts`
- the SQLite runtime DB from `STORAGE_MEMORY_DB_FILE` for cron, monitor state, Telegram monitored chats, outbound audit, and pending notify routing

Operational rule:

- back up `STORAGE_MEMORY_DB_FILE`
- back up `STORAGE_MEMORY_DB_FILE-wal`
- back up `STORAGE_MEMORY_DB_FILE-shm`
- back up PostgreSQL too when `STORAGE_DRIVER=postgres`

### Additional 0.2.3 release-critical state

Before rollout, also treat these as release-relevant:

- `SOUL_CONFIG_PATH` target, if used
- bundled/default soul config files that the backend image ships with
- any persistent turn-execution state stored by the selected `storage.driver`

### Safe rollout sequence

1. Stop the backend or quiesce writes.
2. Back up `STORAGE_MEMORY_DB_FILE` and its WAL/SHM sidecars.
3. Back up PostgreSQL too if `STORAGE_DRIVER=postgres`.
4. Preserve the active soul-config override file if `SOUL_CONFIG_PATH` is in use.
5. Deploy the new backend and frontend artifacts.
6. Start the backend and wait for boot-time initialization.
7. Verify `/api/health`.
8. Verify `/api/ops/diagnostics` before resuming normal operator activity.
9. Open the frontend ops runtime tab and confirm diagnostics cards and warnings render correctly.

## 0.2.3 smoke checks

### Backend/API

Run these after deploy:

- `GET /api/health` returns `ok`
- `GET /api/ops/diagnostics` returns:
  - `health`
  - `llm`
  - `soul`
  - `startup.storage`
  - `startup.telegram`
  - `startup.applescript`
  - `memory.processingState`
  - `prompt.latest`
  - `telegramClient.monitoredChats`
  - `telegramClient.runtimeStates`
  - `continuation.active`
  - `qdrant`
  - `warnings`
- `GET /api/ops/diagnostics` is still protected by the admin API key
- Telegram disabled hosts report `enabled=false` without misleading allowlist warnings
- non-macOS hosts report `applescript.status=unsupported_os` without incident-style noise
- managed-memory diagnostics reflect current fact/episodic counts and processing-state version
- prompt diagnostics expose explicit reserve buckets and available prompt tokens

### Frontend/admin UX

Open the ops page and verify:

- the runtime tab still shows monitored chats and runtime states
- the runtime tab now also shows unified diagnostics cards for:
  - health/runtime profile
  - soul config source metadata
  - startup config summary
  - memory/vector state
  - prompt diagnostics
- monitored chats and Telegram client runtime state are sourced from the unified `/api/ops/diagnostics` payload rather than separate runtime fetches
- runtime warnings render actionable messages and recommended actions
- continuation checkpoints render phase, scope key, expiry, and budget pressure
- the runtime tab still refreshes correctly after monitored-chat edits
- prompt diagnostics show execution reasons and explicit reserve visibility instead of only aggregate pressure

### Large-task/runtime behavior

Target these explicitly:

- an oversized prompt goes through the budget layer instead of falling straight into a provider token-overflow failure
- a large turn that exceeds the comfortable prompt window reports trimming/compression diagnostics instead of failing silently
- staged execution creates an active continuation checkpoint when a turn cannot finish in one pass
- timeout or budget exhaustion returns a continuation-ready partial result instead of a dead-end failure
- continuation metadata persists and reappears in `/api/ops/diagnostics`
- managed-memory mutation results remain deterministic for exact and ambiguous targets

## Targeted verification executed for 0.2.3

The following commands were executed locally during 0.2.3 hardening:

- `backend`: `npm run build`
- `backend`: `npx jest --runInBand src/llm/llm.service.spec.ts src/chat/chat.service.spec.ts`
- `backend`: `npx jest --runInBand src/telegram/auth/telegram.auth.service.spec.ts src/telegram/bot/telegram.service.spec.ts src/tools/builtin/system/applescript.tool.spec.ts`
- `backend`: `npx jest --config ./test/jest-e2e.json --runInBand test/e2e/ops-admin.e2e-spec.ts`
- `frontend`: `npm run build`
- `frontend`: `npm run test -- src/stores/ops/ops.store.test.ts`
- `root`: `npm run verify`

Recommended final sign-off still includes the broader project-level release verification from `RELEASING.md`.

## Rollback notes

### Rollback rule

For rollback from 0.2.3 to an older artifact, restore backed-up runtime state instead of trusting semantic backward-compatibility of newly written diagnostics or execution-state data.

Reason:

- 0.2.3 introduces new turn-execution persistence semantics
- managed-memory processing metadata is more operationally visible and more relied upon by diagnostics
- startup/runtime warnings now depend on richer structured state

### Recommended rollback procedure

1. Stop the backend.
2. Redeploy the previous application artifact.
3. Restore the pre-upgrade `STORAGE_MEMORY_DB_FILE` backup and WAL/SHM sidecars.
4. Restore PostgreSQL backup too if the deployment changed PostgreSQL-backed chat/memory/execution-state data and full point-in-time parity is required.
5. Restore the pre-upgrade soul config file if the rollout also changed soul overrides.
6. Start the backend.
7. Re-run `/api/health`.
8. Re-run `/api/ops/diagnostics`.
9. Re-check the frontend ops runtime tab and any Telegram runtime expectations.

### What not to do

Do not:

- downgrade the binary while keeping newly written 0.2.3 execution-state data without validation
- treat `core_contract_fallback` soul mode as normal production behavior unless intentionally chosen
- assume Telegram warnings are meaningful when `TELEGRAM_ENABLED=false`
- treat unsupported AppleScript on Linux as a rollback condition by itself

## Release-owner sign-off checklist

Mark 0.2.3 ready only when all of the following are true:

- managed memory, prompt budget, and continuation-state changes are reflected in docs
- targeted backend unit tests are green
- unified ops diagnostics e2e is green
- frontend diagnostics/store verification is green
- smoke checks passed in the target environment
- rollback backups are stored and procedurally validated
- `CHANGELOG.md`, `RELEASING.md`, and version metadata reflect the final release state
