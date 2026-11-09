---
paths:
  - apps/web/src/ui/**
  - apps/web/vite.config.ts
  - apps/web/postcss.config.js
---

# UI Patterns

React 19 + Vite, DaisyUI 5 on Tailwind v4, React Router 7, TanStack Query 5; served as Workers
Static Assets (SPA fallback). Dev: Vite :3000 proxies `/api`, `/auth`, `/ws` (+ each installed
plugin's prefixes, written by `pnpm plugin add` from its `coreEdits`) to `wrangler dev` :3001;
`DEV_UI_PORT` / `DEV_API_PORT` / `DEV_ALLOWED_HOSTS` (`scripts/lib/dev-ports.mjs`). Map,
providers, identity flow: `apps/web/src/ui/CLAUDE.md`.

## Design tokens, not raw colours

- Themes are two `@plugin "daisyui/theme"` blocks in `apps/web/src/shared/theme-tokens.css`
  (`rocketflare-light` default, `rocketflare-dark` prefersdark), imported by `ui/index.css` and by
  any public-site stylesheet; its brand variables are the ONLY place a hex appears (rebrand steps:
  the header comment in `ui/index.css`). Use DaisyUI semantic classes
  (`bg-base-200`, `badge-warning`) or the kit's tokens (`--surface-*`, `--border-*`, `--text-*`,
  `--tone-*`; `.surface-panel`, `.data-table`, `.status-badge`, `.text-muted`); **never
  `bg-blue-50`-style palette utilities**
- `apps/web/tests/ui/contrast.test.ts` gates the emitted tokens (WCAG); if you change a colour, run it
- Theme state is `data-theme` on `<html>` (`ThemeToggle`), mirrored to `localStorage['theme']`
- Tailwind scanning is scoped (`source(none)` + explicit `@source` lines in `index.css`, including
  `../plugins/**/ui/**`, without which a plugin page renders unstyled); unscoped, v4 scans the whole
  repo and DaisyUI emits a component per stray class-like word. Never `@source` node_modules without
  measuring. Safelist (`@source inline(...)`) only prop-built classes, never data or a dependency
- Heroicons only (`components/icons` marks use `currentColor`); `<details>/<summary>` dropdowns;
  `<dialog>` `Modal` capped at `max-h-[85vh]` — the BODY scrolls, title and actions stay. No new
  UI library without a stated reason in the PR

## Data layer

- Imports: `@/ui/...` and `@rocketflare/shared/...` (never a relative path into `packages/`); never
  import from `src/api`, `src/db` or `src/permissions` — the ability MATRIX is server code, the UI
  only unpacks rules
- All HTTP via `lib/api-client.ts` (`api.get/post/put/patch/delete/upload`): cookie credentials,
  typed `ApiError` from the shared envelope, a `schema` option that zod-parses the response with
  the same `@rocketflare/shared/<module>` schema the server uses. No `hono/client` RPC (D13)
- Server data lives ONLY in the query cache. One hook file per resource, `hooks/use<Resource>.ts`,
  exporting `xQueryOptions()` factories + `useX()` + mutation hooks; keys from the `queryKeys`
  factory in `lib/query-keys.ts` — never inline key arrays. `lib/queryClient.ts` is the
  module-level client
- Mutations live in the resource hook and invalidate via `queryKeys`. Write methods toast errors by
  default (`showErrorToast`); success toasts are opt-in (`showSuccessToast` + `successMessage`)
- **Polling rules**: poll only while the server still owes an answer, the decision a pure function
  on the cached row — `refetchInterval: q => runPollInterval(q.state.data?.status)` (`RUN_POLL_MS`
  while **`runOwesAnswer`** = `queued || running`, deliberately NOT `isRunActive`, which includes
  `awaiting_input`; lists while any row owes one); documents `DOCUMENT_POLL_MS` while a row is
  `pending`. A nudged resource still polls (the socket may be down). Never poll a settled row or
  unconditionally; never fight `refetchInterval` with timers in tests
- Pagination meta is `{ page, pageSize, total, totalPages }`; every list renders
  `PaginationControls` (hides itself at one page). Forms: controlled inputs validated with the
  server's `@rocketflare/shared` schema, `FieldError` per field
- Files (D23): `api.upload(url, formData, { schema })` posts multipart **without** a JSON
  `Content-Type`. Check type/size with `@rocketflare/shared/files` first (`validateAvatarFile`) so
  413/415 are a backstop. `<img src={user.avatarUrl}>` needs an `onError` fallback to initials —
  the object is tenant-scoped, the URL is not
- **A third-party provider with its own TanStack Query** escapes the global `onError`: give it a
  `QueryClient` mapping 401 → `notifyUnauthorized`, and pass `credentials` + `X-Requested-With`

## State

TanStack Query owns server state — never add a store for it. zustand owns only
`stores/websocketStore.ts` (written by `lib/websocketClient.ts`); theme/density are DOM attributes.

## Realtime (D8) — DB is the truth, the WebSocket is a nudge

- Realtime events never become state: `WebSocketProvider` invalidates query roots and the hooks
  re-fetch. The event → root map is **`REALTIME_INVALIDATIONS` / `invalidationsFor()` in
  `@rocketflare/shared/realtime`**; a new event type adds its roots there
  (`tests/ui/websocket-provider.test.tsx` asserts each is a real `queryKeys` family)
- **Convention: the `entity` string of an `entity.changed { entity, id }` nudge IS the query-key
  family root** (`entity: 'agent-run'` → `queryKeys.agentRuns.all` = `['agent-run']`). Adding a
  resource: pick the root first, use the same string in the service's nudge and `query-keys.ts`,
  and never subscribe to the socket from a hook. Components read query state, never the socket

## Streaming (AG-UI over SSE, D17)

- SSE is consumed with **`fetch`, never `EventSource`** (GET-only, cannot carry the CSRF header),
  through `lib/sse.ts`, never `api-client`'s `request()`. Transports, socket client, frame order:
  `lib/CLAUDE.md`
- **Spec AG-UI frames carry no `event:` line**; the type is inside the JSON, so nothing may key on
  the SSE event field. A new event is an AG-UI type added to `kitAguiEventSchema`, or a CUSTOM
  member, in `@rocketflare/shared/ai/agui` first — an APP's CUSTOM events use its own prefix,
  never `kit.`
- **A read-stream carrying DURABLE rows writes them into the cache; only chat's in-flight text is
  local state** (`pages/chat/CLAUDE.md`). `useRunStream` is the ONLY writer of
  `['agent-run-agui', id]`, which must stay out of `REALTIME_INVALIDATIONS` (a nudge would wipe
  the live timeline). Merge purely, never append blindly
- **A read-stream closing with no terminal event means RECONNECT, not error** — the inverse of the
  chat write-stream, where the stream IS the run and a failure is a `RUN_ERROR`

## Guards

- One guard primitive, `RequireGuard`, decided in ONE place, `useNavGuard` (`AdminRoute` /
  `GlobalAdminRoute` are sugar). Coarse guards are role flags (`'admin'` =
  owner/admin/support/globalAdmin, `'globalAdmin'`); fine gates are abilities
  (`{ action, subject }`, `<IfCan>` / `<IfCannot>`). Owner-ONLY actions (delete org, assign/strip
  owner) check `tenant.role === 'owner'` — `manage Tenant` is also held by support and global
  admins. A `SideNav` item uses the SAME guard as its page. All cosmetic; the server enforces
- **Feature flags (D30)**: gate with `{ feature: 'x' }` as a `NavGuard` or `useFeature('x')`, both
  reading `session.features`. **Never `{ action: 'access', subject: 'Feature:x' }`**: a global
  admin's `manage all` satisfies it, so they would see a nav item whose routes the server 404s. A
  `NavGuard` LIST means AND — `featureGuard(MY_FEATURE, { action: 'read', subject: 'Thing' })`.
  One const per feature, in `lib/feature-guards.ts` for an app's own flag (core ships none), beside
  the route for a plugin's. Tests drive the REAL `useNavGuard`, for a global admin and an owner

## Conventions

- Check `components/shared/` before writing a modal, empty state, toast, pagination control or
  section panel
- **A surface somebody is asked to ACT on is a page, not a modal** (own route and lazy chunk, no
  `role="dialog"`): the decision panel pinned ABOVE the content, **focus lands on its heading and
  never on the destructive button**, a non-approver sees one sentence rather than a disabled
  control, and a 409 is `alert-info` plus a refetch — no toast, no red
- **A countdown chooses its own tick rate from a pure function** (`expiryState` → 1 s under an
  hour, 1 min under a day, `null` beyond). **A growing list windows; it does not virtualise**, and
  auto-scroll fires only when the reader is at the bottom AND the last row's **id** changed
- **A live count in the nav is `NavItem.badgeKey` resolved in `SideNav`**, never a hook inside
  `navigationConfig` (plain data for the pure, tested `filterNavConfig`); fed from a root the
  server already nudges — **never a poll** — with **a dot on the icon when the nav is
  collapsed**
- **A notification's `data` is its deep link** (`lib/notificationLink.ts`, unknown → `null`),
  shared by the bell AND the list
- `components/ai/` (`Markdown`, `ChatBubble`, `StatRows`) is NOT in the eager `components/shared`
  barrel. Import it by path ONLY from `pages/chat/**`, `pages/agents/**` and
  `pages/documents/DocumentViewPage.tsx`; nothing under `components/shared` may import a markdown
  renderer (`tests/config/ui-bundle.test.ts` asserts both). `Markdown` shows images as links
  (`MarkdownImageLink`, also for a plugin's own renderer): text from a model or document must not make the
  browser fetch anything by itself. Model output renders through `Markdown`
  (`skipHtml`, links `noopener`), never `dangerouslySetInnerHTML`; user text verbatim
  (`whitespace-pre-wrap`)
- Heavy dependencies stay in a lazy chunk, never reached from the shared barrel, `App.tsx`,
  `SideNav` or an eager hook; when you touch an import, compare `pnpm web build:ui` before/after
- **Visibility (D29)**: `AccessPicker` / `AccessBadge` / `VisibilityModal` are the ONE wording of
  "who can see this". Render them only where the save would succeed; offer an admin every group, a
  member only `useMyGroups()` (what `resolveRequestedVisibility` accepts). An EMPTY selection is
  WARNED about, never blocked

## Tests

`tests/ui/` (jsdom + Testing Library; `fetch` via `stubFetch()` route tables, no MSW) — run with
`pnpm web test:ui`. Wrap with `renderWithProviders(ui, { session })`; `makeSession()` builds a
post-parse session whose `permissions` come from the real matrix via `packRules(buildAbility(...))`.

## Plugins (D31)

A plugin's UI (`UiPlugin`, `src/plugins/<id>/ui/`; there is no `pages/ExampleFeature.tsx`) and
its eager-entry import allowlist: `apps/web/src/plugins/CLAUDE.md`.
