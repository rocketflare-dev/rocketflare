---
globs:
  - apps/web/src/ui/**
  - apps/web/vite.config.ts
  - apps/web/postcss.config.js
---

# UI Patterns

React 18 + Vite, DaisyUI 5 on Tailwind v4, React Router v6, TanStack Query 5, zustand only for the
websocket store. Served as Workers Static Assets from the same Worker as the API (SPA fallback).
Dev: Vite on :3000 proxies `/api`, `/auth`, `/ws`, `/cubejs-api`, `/mcp` to `wrangler dev` on :3001.

## Design tokens, not raw colours

- Themes are two `@plugin "daisyui/theme"` blocks in `apps/web/src/ui/index.css` (`gm-light` default,
  `gm-dark` prefersdark). The brand variables at the top of that file are the ONLY place a hex
  appears. Components use DaisyUI semantic classes (`bg-base-200`, `text-primary`) or the kit's
  surface/border/text tokens (`--surface-panel`, `--border-subtle`, `.text-muted`); **never
  `bg-blue-50`-style palette utilities**
- `apps/web/tests/ui/contrast.test.ts` gates the emitted tokens (WCAG); if you change a colour, run it
- `ThemeToggle` sets `data-theme` on `<html>`; the DOM attribute is the state, mirrored to
  `localStorage['theme']` and validated on read (`index.html` pre-hydration script)
- Tailwind v4 content scanning: `index.css` starts with `@import "tailwindcss" source(none)` and then
  explicit `@source "./index.html"` / `@source "./**/*.{ts,tsx}"` — scoped to `apps/web/src/ui`.
  **Lesson**: without `source(none)` v4 auto-detects sources from the package root and scans the whole
  repo — docs, API code, tests, migrations — and DaisyUI emits a component for every stray word that
  looks like a class (`card`, `table`, `menu` in a comment). Keep the scan scoped; if a dependency
  ships JSX (drizzle-cube does), `@source` its dist explicitly — never grow a safelist from a
  stylesheet's needs. Safelist (`@source inline(...)`) only classes built from props (`alert-*`,
  `btn-*`), never from data
- Fonts self-hosted via `@fontsource` imports in `main.tsx`

## Providers (06 §b)

`ErrorBoundary` → `QueryClientProvider` → `AuthProvider` → `AbilityProvider` → `WebSocketProvider` →
`BrowserRouter` → routes. `Layout` is mounted once under `/*`; a second `ErrorBoundary` wraps each
`<main>`. Dev-only `ReactQueryDevtools` in a `Suspense`.

## Data layer

- All HTTP via `lib/api-client.ts` (`api.get/post/patch/delete`): `credentials: 'include'`, typed
  `ApiError` from the shared envelope, `schema` option zod-parses the response with the same
  `@gmgo/shared/<module>` schema the server validates with (import from `@gmgo/shared/...`, never a
  relative path into `packages/`). No `hono/client` RPC (D13)
- One hook file per resource in `hooks/use<Resource>.ts`; query keys from the central `queryKeys`
  factory in `lib/query-keys.ts` — never inline key arrays. `lib/queryClient.ts` holds the client
  and its global `QueryCache.onError`
- `queryOptions()` factories in `lib/query-options.ts` for anything used by more than one component
- Mutations invalidate via `queryKeys`; error toast on by default (`showToast`)
- Global 401: `QueryCache.onError` clears the client and redirects to `/login?returnUrl=` (D20)
- Pagination meta is `{ page, pageSize, total, totalPages }`; `PaginationControls` consumes it

## State

TanStack Query owns server state. zustand owns exactly one thing: the websocket connection state
and its entity → query-key invalidation map (`stores/websocketStore.ts`). Component-local UI state is
`useState`; theme and density are DOM attributes. Do not add a store for server data.

## Realtime

`lib/websocketClient.ts` singleton connects to `/ws?tenantId=` (same origin), jittered exponential
backoff, GM upgrade fast-path. Events flow store → `entityInvalidations` → `queryClient.invalidate`.
Components subscribe to query state, never to the socket. Show `ConnectionBanner` when degraded.

## Auth and guards

- `hooks/useAuth.tsx` wraps `GET /auth/session` (zod-parsed) and exposes `useTenancyMode()` so
  single-tenant deployments hide `OrgSwitcher`, `/select-tenant` and org create/delete (D25)
- One guard primitive, `RequireGuard` (`components/RequireGuard.tsx`), composed into coarse role
  guards (authenticated, owner/admin, global admin) and fine ability guards (`RequireAbility`,
  `<Can I="manage" a="Tenant">` from `components/permissions/`). `SideNav` item flags use the SAME
  guard as the page they open
- OAuth is a full-page redirect to `/auth/:provider`; magic link via `POST /auth/magic-link/request`;
  `GET /auth/methods` drives which buttons render

## Conventions

- Pages in `pages/` (lazy in `App.tsx`), reusable primitives in `components/shared/` — check there
  before writing a modal, empty state, toast, pagination control or section panel
- Forms validate with the `@gmgo/shared` schema the server uses; show `FieldError` per field
- Icons: `@heroicons/react`. No new UI library without a stated reason in the PR
- `EnvironmentBadge` + `useEnvironmentTitle` read `APP_ENV`/`RELEASE_VERSION` from `/auth/session`;
  staging must look different from production
