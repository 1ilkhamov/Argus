# Frontend

## Overview

The frontend is a React 18 + Vite 6 application located in `frontend/`.

It is the main user interface for Argus and provides:

- chat UI
- conversation history and sidebar navigation
- settings UI
- memory inspection and management UI
- tool visibility UI
- Telegram and Telegram client management surfaces through backend APIs

The main entrypoints are:

- `frontend/src/main.tsx`
- `frontend/src/App.tsx`

## Runtime defaults

Current frontend runtime defaults come from `frontend/vite.config.ts` and `frontend/.env.example`.

- **Frontend URL**: `http://localhost:2101`
- **Default API base**: `/api`
- **Default dev proxy target**: `http://localhost:2901`

In development, Vite proxies `/api` requests to the backend.

If `API_KEY` is present in `frontend/.env`, the dev proxy injects `X-API-Key` on proxied API requests.

## Main pages

`frontend/src/App.tsx` currently switches between four main surfaces:

- **Chat**
  - main assistant conversation view
  - conversation sidebar
  - new conversation / delete conversation actions
- **Settings**
  - backend-connected settings UI
  - integration and runtime configuration surfaces
- **Memory**
  - memory browsing and management UI
- **Tools**
  - available tools and related status surfaces

## Directory structure

Main frontend directories:

- `src/api`
  - typed API helpers and backend calls
- `src/components`
  - UI components grouped by feature
- `src/config`
  - frontend runtime config and API endpoint definitions
- `src/hooks`
  - reusable React hooks
- `src/i18n`
  - localization resources and language helpers
- `src/stores`
  - Zustand stores for chat and dashboard state
- `src/styles`
  - shared styles
- `src/types`
  - shared frontend types

## API integration

Frontend API paths are defined in `frontend/src/config/api-endpoints.ts`.

Current primary endpoint groups:

- `chat`
- `memory`
- `settings`
- `telegram`
- `telegramClient`
- `tools`
- `health`

The frontend uses backend-relative API paths by default, so local development and Docker can both work without rebuilding the app for every environment.

## Authentication behavior

The frontend supports both of these backend access patterns:

- API key access through proxy-injected `X-API-Key`
- cookie-based public sessions when enabled on the backend

The frontend API client is expected to work with credentialed requests when public sessions are enabled.

## Build and test scripts

Frontend scripts from `frontend/package.json`:

- `npm run dev`
- `npm run build`
- `npm run preview`
- `npm run lint`
- `npm test`

## Environment variables

Current frontend `.env` surface:

- `VITE_API_BASE`
- `VITE_DEV_PROXY_TARGET`
- `API_KEY`
- `ADMIN_API_KEY`

Notes:

- `VITE_*` values are exposed to the frontend bundle
- `API_KEY` and `ADMIN_API_KEY` are meant for server-side proxy/runtime injection and should not be treated as normal public browser config

## What to update when frontend behavior changes

Update this document if you change:

- the main pages in `App.tsx`
- the frontend port or proxy target
- the env surface in `.env.example`
- the endpoint groups in `api-endpoints.ts`
- the main state layout in `src/stores`
