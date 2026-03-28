# Soul Customization

## What this is

Argus supports an optional YAML-based soul config that defines the agent's baseline identity and behavior.

This is handled by `backend/src/agent/identity/config/soul-config.service.ts`.

## Load order

The backend loads the first valid soul config from this priority order:

1. `SOUL_CONFIG_PATH`
2. `backend/data/soul.yml`
3. bundled default config
4. core-contract fallback

In code terms, the service checks:

- configured custom path from `SOUL_CONFIG_PATH`
- `data/soul.yml`
- `src/agent/identity/config/soul.default.yml` or its built equivalent
- internal fallback values

## Recommended customization path

The simplest local override is:

```bash
cp backend/src/agent/identity/config/soul.default.yml backend/data/soul.yml
```

Then edit:

- `backend/data/soul.yml`

No code changes are required.

## Hot reload

If the backend is running and the active soul file is being watched, changes are hot-reloaded automatically.

The service watches:

- the configured custom path, or
- `backend/data/soul.yml`

When the file changes and remains valid, the new config is loaded without a restart.

## Supported config shape

A valid soul config must include these top-level fields:

- `name`
- `role`
- `mission`
- `personality`
- `invariants`
- `never`
- `values`
- `interactionContract`
- `antiGoals`

Optional section:

- `defaultBehavior`

`defaultBehavior` supports:

- `initiative`: `low | medium | high`
- `assertiveness`: `low | medium | high`
- `warmth`: `low | medium | high`
- `verbosity`: `adaptive | concise | detailed`

## Validation rules

The config loader validates that:

- `name` and `role` are non-empty strings
- all required list fields are present and contain non-empty strings
- `defaultBehavior` values are from the allowed enums

If the file is invalid, Argus logs a warning and falls back to the next available config source.

## When to use this

Use soul customization if you want to change the agent's baseline:

- tone
- initiative level
- assertiveness
- warmth
- verbosity defaults
- hard identity rules and anti-patterns

Do not use soul config for runtime secrets, environment settings, or tool credentials. Those belong in `.env` or the Settings API.

## Related files

- `backend/src/agent/identity/config/soul.default.yml`
- `backend/src/agent/identity/config/soul-config.service.ts`
- `backend/src/agent/identity/config/soul-config.types.ts`
- `backend/.env.example` (`SOUL_CONFIG_PATH`)
