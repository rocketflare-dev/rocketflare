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

- Themes are two `@plugin "daisyui/theme"` blocks in `apps/web/src/ui/index.css` (`rocketflare-light` default,
  `rocketflare-dark` prefersdark). The brand variables at the top of that file are the ONLY place a hex
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
  looks like a class (`card`, `table`, `menu` in a comment). Keep the scan scoped. A dependency that
  ships pre-built JSX **and uncompiled Tailwind classes** is an explicit `@source` line pointing at
  its dist. drizzle-cube is NOT such a dependency: its styles are precompiled and `dc:`-prefixed in
  `drizzle-cube/client/styles.css` (loaded by the lazy analytics chunk), so scanning its dist generated
  zero of its classes and +6.5 KB gzip of stray DaisyUI components — measured, then removed. Never
  `@source` node_modules without measuring the output first. Safelist (`@source inline(...)`) only classes built from
  props (`alert-*`, `btn-*`), never from data or from a dependency
- Fonts self-hosted via `@fontsource` imports in `main.tsx`

## Providers (06 §b)

`ErrorBoundary` → `QueryClientProvider` → `AuthProvider` → `AbilityProvider` → `WebSocketProvider` →
`BrowserRouter` → routes. `Layout` is mounted once under `/*`; a second `ErrorBoundary` wraps each
`<main>`. Dev-only `ReactQueryDevtools` in a `Suspense`.

## Data layer

- All HTTP via `lib/api-client.ts` (`api.get/post/patch/delete/upload`): `credentials: 'include'`, typed
  `ApiError` from the shared envelope, `schema` option zod-parses the response with the same
  `@rocketflare/shared/<module>` schema the server validates with (import from `@rocketflare/shared/...`, never a
  relative path into `packages/`). No `hono/client` RPC (D13)
- Files (D23): `api.upload(url, formData, { schema })` posts multipart **without** a JSON
  `Content-Type` (the browser sets the boundary). Check `isAvatarMimeType` / `MAX_UPLOAD_BYTES` from
  `@rocketflare/shared/files` client-side first (`validateAvatarFile` in `hooks/useProfile.ts`) so the
  server's 413/415 are a backstop, not the UX; `useUploadAvatar()` → `POST /api/files?scope=avatars`
  then invalidates `me` + `auth` and refreshes the session. Render `<img src={user.avatarUrl}>` with
  an `onError` fallback to initials — the object is tenant-scoped, the URL is not
- One hook file per resource in `hooks/use<Resource>.ts`; query keys from the central `queryKeys`
  factory in `lib/query-keys.ts` — never inline key arrays. `lib/queryClient.ts` holds the client
  and its global `QueryCache.onError`
- `queryOptions()` factories in `lib/query-options.ts` for anything used by more than one component
- Mutations invalidate via `queryKeys`; error toast on by default (`showToast`)
- **Polling rules** (Phase 3b): poll only while the server still owes an answer, with the decision as a
  pure function on the cached row — `refetchInterval: q => runPollInterval(q.state.data?.status)`
  (`RUN_POLL_MS` 3 s while `isRunActive`; lists poll while any listed row is active); documents 5 s
  (`DOCUMENT_POLL_MS`) while a row is `pending`. Polling is the belt to the nudge's braces — a resource
  that has a server nudge still polls (the socket may be down); a resource without one (documents) polls
  only. Never poll a settled row, never poll unconditionally, never fight `refetchInterval` with timers in tests
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
root map is **`REALTIME_INVALIDATIONS` / `invalidationsFor()` in `@rocketflare/shared/realtime`**, not in
the UI — a new server event type adds its roots there, and `tests/ui` asserts every root is a real
`queryKeys` family (`['invitations']`, `['pending-invitations']`, `['members']`, `['tenant']`…).
**Convention: the `entity` string of an `entity.changed { entity, id }` nudge IS the query-key family
root** — `invalidationsFor()` returns `[[entity]]`, so a resource whose server nudges
`entity: 'agent-run'` names its family `['agent-run']` (`queryKeys.agentRuns.all`) and gets live
refresh with zero hook-side socket code. When you add a resource: pick the root first, use the same
string in the service's nudge and in `query-keys.ts`, and never subscribe to the socket from a hook.
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
  type is a `chatStreamEventSchema` variant in `@rocketflare/shared/ai/chat` first
- Guards: `/chat/:conversationId?` is `read Conversation` (every role; ownership is server-side);
  `/settings` (`?tab=ai|prompts|agent-models|usage`) is `guard="admin"`, the last two additionally
  `manage AiConfig`. Agent runs (`/agents`, `AgentRun`), documents (`/documents`, `Document`) and the
  agent-models tab follow the same contracts (`@rocketflare/shared/ai/{agents,embeddings,agent-models}`) and
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
  never `dangerouslySetInnerHTML`; user text renders verbatim (`whitespace-pre-wrap`). `pages/agents/**`
  imports `Markdown` too and is lazy for the same reason (Vite emits one shared `Markdown-*.js`)
- **Analytics chunk isolation (D19)**: `drizzle-cube/client`, `recharts`, `d3`, `react-grid-layout` and
  `react-is` ship ONLY in the lazy analytics chunk — import them from `pages/analytics/**` /
  `components/analytics/**` by path, never from the `components/shared` barrel, `App.tsx`, `SideNav` or
  a hook the shell loads eagerly; the main chunk must stay ≈ 114 KiB gzip. Check `pnpm web build:ui`
  output when you touch an import. The server contract the pages consume is `@rocketflare/shared/analytics`
  + `/cubejs-api/v1/*` (drizzle-cube's own client); page specifics: `apps/web/src/ui/CLAUDE.md`
- **Third-party providers with their own TanStack Query** (drizzle-cube does this): the app's global
  `QueryCache.onError` never sees their failures. Wrap them (`components/analytics/CubeClientProvider.tsx`)
  with a dedicated `QueryClient` whose `onError` maps 401 → `notifyUnauthorized`, and pass cookie auth
  explicitly (`credentials: 'include'`, `X-Requested-With`). Kit hooks rendered inside still resolve the
  app's client.
- **Dashboards**: edit mode autosaves the whole config (debounced 1.5 s PATCH); there is no router-level
  unsaved-changes blocker — `beforeunload` while dirty plus a flush when leaving edit mode/unmount.
  `useFactTableStatus({ enabled })` MUST be gated on `manage Dashboard` (admin-only endpoint).
  `syncDarkClass` mirrors `data-theme="rocketflare-dark"` into a `dark` class only while an analytics surface is
  mounted (drizzle-cube detects `.dark`); kit CSS never reads `.dark`. `@nivo/heatmap` is aliased to a stub
  in `vite.config.ts` — see `docs/ADAPTING.md` §3b to enable heat maps.
- Forms validate with the `@rocketflare/shared` schema the server uses; show `FieldError` per field
- Icons: `@heroicons/react`. No new UI library without a stated reason in the PR
- `EnvironmentBadge` + `useEnvironmentTitle` read `APP_ENV`/`RELEASE_VERSION` from `/auth/session`;
  staging must look different from production
