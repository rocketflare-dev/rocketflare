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

- All HTTP via `lib/api-client.ts` (`api.get/post/patch/delete/upload`): `credentials: 'include'`, typed
  `ApiError` from the shared envelope, `schema` option zod-parses the response with the same
  `@gmgo/shared/<module>` schema the server validates with (import from `@gmgo/shared/...`, never a
  relative path into `packages/`). No `hono/client` RPC (D13)
- Files (D23): `api.upload(url, formData, { schema })` posts multipart **without** a JSON
  `Content-Type` (the browser sets the boundary). Check `isAvatarMimeType` / `MAX_UPLOAD_BYTES` from
  `@gmgo/shared/files` client-side first (`validateAvatarFile` in `hooks/useProfile.ts`) so the
  server's 413/415 are a backstop, not the UX; `useUploadAvatar()` → `POST /api/files?scope=avatars`
  then invalidates `me` + `auth` and refreshes the session. Render `<img src={user.avatarUrl}>` with
  an `onError` fallback to initials — the object is tenant-scoped, the URL is not
- One hook file per resource in `hooks/use<Resource>.ts`; query keys from the central `queryKeys`
  factory in `lib/query-keys.ts` — never inline key arrays. `lib/queryClient.ts` holds the client
  and its global `QueryCache.onError`
- `queryOptions()` factories in `lib/query-options.ts` for anything used by more than one component
- Mutations invalidate via `queryKeys`; error toast on by default (`showToast`)
- Global 401: `QueryCache.onError` clears the client and redirects to `/login?returnUrl=` (D20)
- Pagination meta is `{ page, pageSize, total, totalPages }`; `PaginationControls` consumes it

## State

TanStack Query owns server state. zustand owns exactly one thing: the websocket connection state
(`stores/websocketStore.ts`: `status: 'connecting' | 'open' | 'closed'`, `connectedAt`,
`disconnectedAt` — kept at the FIRST drop so the banner measures the whole outage — `attempt`,
`lastEvent`; written only by `lib/websocketClient.ts`). Component-local UI state is `useState`;
theme and density are DOM attributes. Do not add a store for server data.

## Realtime (D8)

`lib/websocketClient.ts` singleton (outside React) connects to `/ws?tenantId=` (same origin — the
Vite proxy forwards it in dev); reconnects with exponential backoff (base `min(1 s · 2^attempt,
30 s)`, jittered in `[base/2, base]`), and a close with code 1001/1012 or reason "upgraded"/"new
version" (Worker redeployed) reconnects in 100 ms without counting as a failure; sends
`{"type":"ping"}` every 30 s. Events are parsed with `realtimeEventSchema`; the event type → query-key
root map is **`REALTIME_INVALIDATIONS` / `invalidationsFor()` in `@gmgo/shared/realtime`**, not in
the UI — a new server event type adds its roots there, and `tests/ui` asserts every root is a real
`queryKeys` family (`['invitations']`, `['pending-invitations']`, `['members']`, `['tenant']`…).
`components/WebSocketProvider.tsx` (after `AbilityProvider`) connects once `useAuth()` is
authenticated with a tenant, reconnects on tenant switch, disconnects on sign-out, and uses
`useQueryClient()` to `invalidateQueries({ queryKey })` per root, toasting `notification.created`.
Components subscribe to query state, never to the socket; `WebSocketStatus` (header dot) and
`ConnectionBanner` (after 5 s degraded) read the store only. Tests inject a fake socket with
`websocketClient.setFactory()` — reset it in `afterEach`.

## Streaming (SSE, D17)

- SSE is consumed with **`fetch`, never `EventSource`** (GET-only, cannot carry the CSRF header): `lib/chatStream.ts`
  POSTs with `credentials: 'include'` + `X-Requested-With` and reads the body through `lib/sse.ts`
  (`readSse(response, onEvent, { signal })`, `SseFrameBuffer` survives frames split across chunks,
  each `data` is `chatStreamEventSchema.safeParse`d and unknown frames are dropped, never thrown).
  It does not go through `api-client`'s `request()` (JSON only) but reuses `parseErrorBody`: a pre-stream
  non-2xx is the shared envelope — 503 `ai_not_configured` becomes `AiNotConfiguredError` so the page
  renders a "configure AI" call to action instead of a toast
- **Streaming text is the one exception to "server data lives only in the cache"**: `useSendMessage`
  appends the user bubble optimistically, accumulates the assistant reply in LOCAL state from
  `text.delta` frames (not truth until `message.end`), then writes the finished message into the cache
  (the server persisted it BEFORE that frame) and invalidates the `chat.conversations` family. Stop =
  `AbortController.abort()` — a normal end, no toast, no error bubble; a pre-stream failure takes the
  optimistic bubble back; an `error` frame leaves the turn in `error` status until the next send
- Frame order the UI relies on: `message.start` (swap the optimistic user id for `userMessageId`) →
  `text.delta*` → `usage` → `message.end`; `tool.start`/`tool.end` render as one-liners. A new frame
  type is a `chatStreamEventSchema` variant in `@gmgo/shared/ai/chat` first
- Guards: `/chat/:conversationId?` is `read Conversation` (every role; ownership is server-side);
  `/settings` (`?tab=ai|prompts|agent-models|usage`) is `guard="admin"`, the last two additionally
  `manage AiConfig`. Agent runs (`/agents`, `AgentRun`), documents (`/documents`, `Document`) and the
  agent-models tab follow the same contracts (`@gmgo/shared/ai/{agents,embeddings,agent-models}`) and
  poll/nudge, never stream: `entity.changed { entity: 'agent-run' }` invalidates the run query.
  Page specifics: `apps/web/src/ui/CLAUDE.md`

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
- `components/ai/` (`Markdown`, `ChatBubble`) is deliberately NOT exported from the
  `components/shared` barrel that `App.tsx` imports eagerly: `react-markdown` + `remark-gfm` must ship
  only in the lazy chat chunk (`ChatPage` ≈ 54 KiB gzip vs ≈ 114 KiB for the main bundle). Import them
  by path from lazy pages only; render model output through `Markdown` (`skipHtml`, links `noopener`),
  never `dangerouslySetInnerHTML`; user text renders verbatim (`whitespace-pre-wrap`)
- Forms validate with the `@gmgo/shared` schema the server uses; show `FieldError` per field
- Icons: `@heroicons/react`. No new UI library without a stated reason in the PR
- `EnvironmentBadge` + `useEnvironmentTitle` read `APP_ENV`/`RELEASE_VERSION` from `/auth/session`;
  staging must look different from production
