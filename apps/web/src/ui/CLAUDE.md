# UI (React SPA)

React 18 + Vite + React Router 6 + TanStack Query 5 + zustand; DaisyUI 5 on Tailwind v4. Dev: Vite on
:3000 proxies `/api`,`/auth`,`/ws`,`/cubejs-api`,`/mcp` → :3001. Prod: `dist/ui` via the `ASSETS` binding.

## Layout

- `App.tsx` — providers (ErrorBoundary → QueryClient → Auth → Ability → WebSocket → Router), the
  header `<WebSocketStatus />` dot and `<ConnectionBanner />` above the routed page, and the route
  table in three tiers: public (`/login`, `/magic-link/sent`, `/invite/:token`), signed-in-without-
  tenant (`/select-tenant`, `/pending`, `/no-access` — `ProtectedRoute requireTenant={false}`), and
  the shell (`/*` — `ProtectedRoute`, `Layout` mounted ONCE, nested `<Routes>` beneath it).
- `index.css` — the design system: themes `rocketflare-light`/`rocketflare-dark`, semantic tokens (`--surface-*`,
  `--border-*`, `--text-*`, `--tone-*`), primitives (`.surface-panel`, `.data-table`,
  `.status-badge`, `.nav-item`). Rebrand instructions are in its header comment.
- `components/` — shell: `Layout` (slots `headerStart`=`OrgSwitcher`, `headerEnd`=`NotificationsBell`
  + `UserMenu`, `sidebarFooter`), `SideNav` (config-driven, `guard` flags), `AuthCard` (public-page
  card), `PendingInvitationsBanner`, `RoleBadge`, `EnvironmentBadge`, `ThemeToggle`, `ErrorBoundary`.
  Guards: `ProtectedRoute` (session + tenant → `noTenantRoute`), `RequireGuard` (any `NavGuard`),
  `AdminRoute`/`GlobalAdminRoute` (sugar over it). `components/permissions/` — `AbilityProvider`
  (unpacks `session.permissions`), `Can`, `IfCan`/`IfCannot`. Realtime (D8): `WebSocketProvider`
  (connects the singleton once authenticated with a tenant, `useQueryClient()` →
  `invalidateQueries` per root from `invalidationsFor(event)`, toasts `notification.created`),
  `WebSocketStatus` (header dot), `ConnectionBanner` (after 5 s away from `open`).
  `components/shared/` — generic primitives only (Toast, Modal, SectionPanel, PaginationControls,
  FieldError…). `components/ai/` (D17) — `Markdown` (react-markdown + GFM, `skipHtml`, links
  `noopener`) and `ChatBubble`; deliberately NOT in the shared barrel so the markdown dependency
  ships only in the lazy chat chunk.
- `hooks/` — `useAuth` (session, `status`, `selectTenant`, `logout`, `applySession`,
  `useTenancyMode`), `usePermissions` (`can/cannot/isOwnerLevel/isAdminLevel/isGlobalAdmin`),
  `useNavGuard` (the ONE place nav and route guards are decided), one file per resource
  (`useMembers`, `useInvitations`, `useApiKeys`, `useNotifications`, `useTenant`, `useProfile`,
  `useActivity`, `useAccessRequests`, `useAdminAccessRequests`, `useAdminTenants`, `useAdminUsers`,
  `useAuthMethods`) exporting `xQueryOptions()` + `useX()` + mutation hooks; `useProfile` also
  holds the avatar upload (`useUploadAvatar`, `validateAvatarFile`, `AVATAR_ACCEPT` — D23);
  `useAppInfo`, `useDebounce`, `useModalState`, `useLocalStoragePreference`. AI (D17/D18):
  `useAiConfig` (`useAiConfigs/useAiProviders/useAiReadiness`, `useUpsertAiConfig`,
  `useDeleteAiConfig`, `useTestAiConfig`; `providersForScope`, `configsForScope`), `usePrompts`
  (`usePrompts`, `useUpdatePrompt`, `useClearPrompt`), `useAiUsage` (`useAiUsageSummary(days)`,
  keyed on the PRESET, window derived in `queryFn`), `useChat` (`useConversations` paginated,
  `useConversation(id)`, `useCreateConversation`, `useDeleteConversation`, `useSendMessage`).
  Phase 3b (D7/D18): `useAgents` (`useAgentList`, `useAgentRuns` paginated + filters,
  `useAgentRun(id)` polling `RUN_POLL_MS` while `isRunActive`, `useCreateAgentRun`,
  `useCancelAgentRun`, `isAgentRunsNotConfigured`, `runPollInterval`), `useAgentModels`
  (`useAgentModels`, `useUpsertAgentModel`, `useDeleteAgentModel`), `useDocuments` (`useDocuments`
  polling while any row is `pending`, `useDocument`, `useIngestText`, `useDeleteDocument`,
  `useSearch` — mutation-style, hits are its `data`).
  Analytics (Phase 4, D19): `useAnalyticsPages` (`useAnalyticsPages` default-first via
  `orderPages`, `useAnalyticsPage(id)`, `useCreateAnalyticsPage`, `useUpdateAnalyticsPage`,
  `useAutosaveDashboardConfig(pageId)` — debounced whole-config PATCH, `DASHBOARD_AUTOSAVE_MS`,
  `useDeleteAnalyticsPage`, `useResetAnalyticsPage`, `useAnalyticsTemplates`,
  `useRecreateTemplates`, `useFactTableStatus({ enabled })`), `useCubeMeta` (`GET
  /cubejs-api/v1/meta` via `api.get`, cached an hour; `memberTitle`, `timeDimensionsOf`),
  `useDashboardDateFilter` (URL-synced `?range=7d|30d|90d|custom&from&to`; pure
  `parseDateFilterParams`, `dateRangeValue`, `dashboardDateFilters(config, range)`).
- `lib/` — `api-client` (fetch wrapper, `ApiError`, `setUnauthorizedHandler`, `api.upload` for
  multipart — no JSON content-type), `queryClient` (module-level, 401 → handler), `query-keys`
  (factory + `cleanFilters`/`toSearchParams`; the family roots — `['invitations']`,
  `['pending-invitations']`, `['members']`, `['tenant']`… — are what `REALTIME_INVALIDATIONS` in
  `@rocketflare/shared/realtime` names; `agentRuns.all` is `['agent-run']` because that is the `entity`
  the server's `entity.changed` nudge carries — see "Agents" below), `websocketClient`
  (singleton: `/ws?tenantId=`, jittered backoff 1 s → 30 s, 100 ms fast path on close 1001/1012
  or an "upgraded" reason, 30 s ping;
  `setFactory()` is the test seam), `navigation` (`NavigationBridge`, `navigateTo`, `hardNavigate`,
  `loginUrl`, `safeReturnUrl`), `format` (date-fns helpers), `environment`, `sse` (D17:
  `readSse(response, onEvent, { signal })` — `event:`/`data:` frame splitter that survives split
  chunks and validates each `data` with `chatStreamEventSchema`; `SseFrameBuffer`, `parseSseFrame`),
  `chatStream` (`sendChatMessage({ conversationId, content, onEvent, signal })` POSTs and streams;
  a pre-stream 503 `ai_not_configured` throws `AiNotConfiguredError`; `isAiNotConfigured()`),
  `stubs/nivo-heatmap.tsx` (D19: the build-time stand-in `vite.config.ts` aliases `@nivo/heatmap`
  to — see "Analytics dashboards").
- `stores/websocketStore.ts` — the one zustand store: `status | connectedAt | disconnectedAt |
  attempt | lastEvent`; written only by `websocketClient`, read by the status dot and the banner.
- `pages/` — route-level components, lazy in `App.tsx` except Home/Login/NotFound. `Login.tsx`:
  `GET /auth/methods` drives the buttons; `?as=<email>` (what `pnpm bootstrap` opens) calls
  `POST /auth/dev-login` once on mount, ONLY when `methods.devLogin` is true AND the email is in
  `DEV_ACCOUNTS` (the allow-list; an arbitrary address does nothing). `settings/`
  is one page with `URLTabs` (`?tab=general|people|api-keys|ai|prompts|agent-models|usage`;
  `agent-models` and `usage` only for `manage AiConfig`); `admin/` is nested routes under `AdminLayout`; `chat/ChatPage.tsx` is
  `/chat/:conversationId?` (D17, guard `read Conversation`, lazy — its chunk carries the markdown
  renderer). `agents/` — `/agents` + `/agents/runs/:runId` (D7, guard `read AgentRun`; the same
  `AgentsPage` for both, the param opens `RunDetailDrawer`); `documents/DocumentsPage.tsx` —
  `/documents` (D18, guard `read Document`, nav label "Knowledge"). `analytics/` — `/analytics`
  (`DashboardListPage`), `/analytics/explore` (`QueryBuilderPage`), `/analytics/:pageId`
  (`DashboardViewPage`), all `read Analytics` (D19, below). `public/` — static assets copied as-is.
- `components/analytics/` (D19) — `CubeClientProvider` (drizzle-cube `CubeProvider` + cookie auth
  + 401 routing + the library stylesheet), `DashboardLoader` (`AnalyticsDashboard` glue: local
  config, date-filter overrides, autosave, unsaved guard), `DashboardFormModal` (create/rename,
  optional "start from template"), `DateRangeControl`. Like `components/ai/`, NOT in the shared
  barrel: importing any of them pulls the drizzle-cube runtime into the chunk.

## Conventions

- Imports: `@/ui/...` and `@rocketflare/shared/...`; never import from `src/api`, `src/db` or
  `src/permissions` (the ability MATRIX is server code; the UI only unpacks rules).
- Server data lives ONLY in the query cache: `useQuery` + a key from `query-keys.ts` + a
  `@rocketflare/shared` zod `schema` on `api.get`. Mutations live in the resource hook, `invalidateQueries`
  through `queryKeys`, and toast via `showSuccessToast`/`successMessage`.
- zustand is for UI state only (toasts, connection state, tab-lifetime flags). Realtime events
  never become state: the provider invalidates query roots and the hooks re-fetch ("DB is the
  truth, WebSocket is a nudge"). A new server event type gets its roots in
  `packages/shared/src/realtime.ts`, not in a component.
- Uploads: `api.upload('/api/files?scope=…', formData, { schema: uploadResponseSchema })`; check
  type/size with `@rocketflare/shared/files` before sending; `<img>` avatars need an `onError` fallback
  (the object is tenant-scoped, `avatarUrl` is not).
- Tokens, not raw colours: `text-muted`, `surface-panel`, `badge-warning` — never `bg-blue-50`.
  Classes built from props are safelisted with `@source inline(...)` in `index.css`; classes
  built from data are forbidden. Heroicons only (provider marks in `components/icons` are
  `currentColor`); `<details>/<summary>` dropdowns; `<dialog>` `Modal` (column layout, `max-h-[85vh]`: the BODY
  scrolls, title and actions stay — never let a modal grow past the viewport).
- Forms: controlled inputs + the same `@rocketflare/shared` schema the server validates with; `FieldError`.
  Every list renders `PaginationControls` (it hides itself at one page).
- Tests in `tests/ui/` (jsdom + Testing Library, `fetch` via `stubFetch()` route tables, no MSW);
  wrap with `renderWithProviders(ui, { session })` — `makeSession()` builds a post-parse session
  whose `permissions` come from the real matrix via `packRules(buildAbility(...))`.

## Identity flow (Phase 1)

- `useAuth` runs ONE query, `GET /auth/session`; a 401 resolves to `null` (logged out) so the
  query is never removed. Identity changes (`selectTenant`, invite accept, logout, global 401) go
  through `replaceSession()`: `setQueryData` on the session, then `resetQueries`/`removeQueries`
  on everything tenant-scoped. Never `queryClient.clear()` while observers are mounted.
- Global 401 (D20): the handler only acts when a session WAS cached, drops it, and `navigateTo`s
  `/login?returnUrl=` unless already on a public path. OAuth/dev-login/logout are full-page
  (`hardNavigate`) so the cookie round-trips cleanly.
- No active tenant → `noTenantRoute(session)`: access request → `/pending`; memberships →
  `/select-tenant`; `signupMode === 'approval'` → `/pending`; else `/no-access`.
- Single-tenant mode (D25) hides: `OrgSwitcher`, `/select-tenant` (redirects home), org
  create/delete and the slug field, the `new_org` approve branch, and collapses `/admin/tenants`
  to the one detail. Read it via `useTenancyMode()`.
- Coarse guards are role flags (`'admin'` = owner/admin/support/globalAdmin, `'globalAdmin'`);
  fine gates are abilities (`{ action, subject }`, `<IfCan>`). Owner-ONLY actions (delete org,
  assign/strip owner) check `tenant.role === 'owner'` explicitly — `manage Tenant` is also held
  by support and global admins.

## AI surface (Phase 3a, D17/D18)

- **Streaming is the one exception to "server data lives only in the cache".** `useSendMessage`
  appends the user bubble optimistically (`setQueryData` on `chat.conversations.detail(id)` with a
  real `Date`), accumulates the assistant reply in LOCAL state from `text.delta` frames (it is not
  truth until `message.end`), captures `usage`, and on `message.end` writes the finished message
  into the cache (the server persisted it BEFORE that frame) then invalidates the whole
  `chat.conversations` family (list re-sorts, auto-title arrives). Stop = `AbortController.abort()`:
  an abort is a normal end (no toast, no error bubble); a pre-stream failure takes the optimistic
  bubble back. An `error` frame leaves the turn in `error` status until the next send.
- SSE never goes through `api-client`'s `request()` (JSON only); `lib/chatStream.ts` does its own
  `fetch` with `credentials: 'include'` + `X-Requested-With` and reuses the exported
  `parseErrorBody` for the envelope. `EventSource` is not used (GET-only).
- `ai_not_configured` (503) — from `POST /api/chat/conversations` (`ApiError`, toast suppressed in
  the hook) or from the send (`AiNotConfiguredError`) — or readiness `chat.ready === false` →
  `ChatPage` renders the `EmptyState` with a "Configure AI" link to `/settings?tab=ai` for
  `manage AiConfig`, "ask an administrator" otherwise.
- Settings → AI: the providers catalog (`GET /api/ai/config/providers`) has NO shared schema (it
  is `services/ai/providers.ts` data), so `useAiConfig.ts` carries a permissive `passthrough`
  one. `PROVIDER_PRESETS`/`presetsFor`, `DEFAULT_MODELS`, `THINKING_*` come from
  `@rocketflare/shared/ai/config`. The label is the upsert key `(tenant, scope, label)` — read-only on
  edit (renaming would create a second row). `apiKey` is write-only: blank on edit keeps the stored
  key (`hasCredential`); switching provider on edit requires a new key. `serviceTier: ''` clears.
  "Set default" re-posts the row with `isDefault: true` and no `apiKey`.
- `/settings` is behind `RequireGuard guard="admin"`, so the member (`read AiConfig` /
  `read Prompt`) read-only rendering of the AI and Prompts tabs is exercised component-level in
  tests only; a member has no nav path to it.
- Tests: `tests/ui/helpers/sse.ts` builds fake `text/event-stream` `Response`s (`sseResponse`,
  `streamResponse` for arbitrary chunking, `hangingSseResponse` for Stop). Bubbles remount when an
  optimistic id becomes the persisted one, so assert with `waitFor(() => getByText…)`, not `findBy`.

## Agents, agent models, knowledge base (Phase 3b, D7/D18)

- **Runs are durable rows, never client state.** `POST /api/agents/runs` answers 202 with the row
  and the page navigates to `/agents/runs/:id`; `RunDetailDrawer` renders `GET /runs/:id` (row +
  `events`, reconciled server-side) through `AgentSteps`. A `deduplicated: true` 202 is a SUCCESS
  (an exclusive agent already had an active run — toast, open that run); 503
  `agent_runs_not_configured` is the modal's business (`isAgentRunsNotConfigured` → `EmptyState`
  naming `AGENT_RUN_WORKFLOW`, no toast); everything else re-toasts. The UI never sends `?strict=1`.
- **Freshness = nudge + poll.** The runs family root is `['agent-run']` (`queryKeys.agentRuns`),
  the `entity` string in the server's `entity.changed { entity: 'agent-run', id }` nudge, so the
  generic `WebSocketProvider` invalidation already covers it — no hook watches the socket or the
  store. Belt and braces: `useAgentRun` polls every `RUN_POLL_MS` (3 s) while `isRunActive`, and
  `useAgentRuns` while any listed row is active. `runPollInterval(status)` is the pure decision
  (unit-tested); don't fight `refetchInterval` with fake timers.
- **Event payloads beyond `step` are `unknown` on the wire.** `AgentSteps.buildTimeline` parses each
  leniently and merges what belongs together: `step` rows by `key`, and a `tool.start`/`tool.end`
  PAIR into ONE row (FIFO per tool name; input and result share the `<details>`, the row spins until
  it returns). An agent should not emit tool frames for its TERMINAL tool — that "call" is the
  answer, which the output panel already renders. Parsers: (`tool.*` → `{ name, …rest }`, `text` → `{ text }`, `status` → `{ status, attempt? }`,
  `error` → `{ message, willRetry? }`), merges `step` rows by `key` (a `done` replaces the row its
  `running` announced) and falls back to a raw `<details>` for anything it does not know. `text`
  renders via `components/ai/Markdown`, which is why `pages/agents/**` is a lazy chunk like
  `ChatPage` — Vite emits `Markdown-*.js` once, shared by both; nothing markdown lands in the main
  chunk. Keep every Markdown importer under `pages/agents|chat/` or `components/ai/`.
- **Forms come from `pages/agents/forms/`**: `formFor(agentKey)` → `{ initial, schema, Component }`.
  `summarize-text` ships its own (textarea counted against `SUMMARIZE_TEXT_MAX_CHARS`, style,
  "index the result" toggle), parsed with the SAME `summarizeTextInputSchema` the route applies
  (trimmed, defaults filled); `research-topic` ships a single question textarea counted against
  `RESEARCH_TOPIC_MAX_CHARS`, and its output panel renders the Markdown answer plus its citations as
  links to `/search?documentId=`. Unknown agents get `jsonForm` (a JSON textarea; the server's 400
  `details` issues map back onto the fields). A new agent = a shared input schema + one registry entry.
- **Closing the drawer never touches the run**; Cancel is the explicit button (`POST …/cancel`, shown
  while active). Once `cancelRequestedAt` is set it stays ENABLED as "Force cancel" — the second
  press makes the server terminate the Workflow instance and settle the row, so a run that stopped
  polling never strands the user (and never blocks an exclusive agent). Requested-by is "You" / short id /
  "system" — the row carries only a user id (resolving names is on the to-document list).
- **Settings → Agent models** (`pages/settings/AgentModels.tsx`, tab `agent-models`, `manage
  AiConfig`): `GET /api/ai/agent-models` is the whole truth (every prompt key, its assignment, and
  the effective provider/model/source the server's planner computed — the page never re-derives
  it). Override modal = pick a chat `ai_configs` row (`configsForScope(configs, 'chat')`; blank =
  keep the default config) and/or type a model; validated with `upsertAgentModelRequestSchema` (at
  least one) and `PUT` sends ONLY the set fields (the PUT replaces the row, so a blank model
  clears it). "Use default" is `DELETE` — absence is the default. Source badges: `agent`
  (assignment), `tenant`, `platform`, `none` (→ EmptyState linking `/settings?tab=ai`).
- **Knowledge (`/documents`)**: the paginated documents table first, then `URLTabs` (`?tab=text|file`, like Settings) to add. Paste text posts
  `ingestTextRequestSchema` output (blank source omitted; the server defaults it to `upload`);
  Upload file checks the pick with `validateDocumentUpload` (the shared allowlist
  `DOCUMENT_UPLOAD_ACCEPT` + `MAX_UPLOAD_BYTES`) before any request, then `useUploadDocument()`
  posts multipart `file` (+ optional `title`/`source`) to `/api/ai/documents/upload`. Both toast
  `indexed (n chunks)` / `queued for …` and invalidate `documents`; the list polls every 5 s while a
  row is `pending` (there is no document nudge yet). Rows show `documentTypeLabel(contentType)`
  under the title and a download link (`filePath(fileId)`) when there is an uploaded original.
- **Search (`/search`, nav "Search", guard `read Document`)**: its own page (`pages/documents/SearchPage.tsx`). The Knowledge header states that everything indexed is also available to agents (`search_knowledge` / `get_document`, `services/agents/tools/`). Delete shows only for own rows unless `delete Document` (admin+) — the route
  enforces. Search is `useSearch()` (mutation): `{ query, limit: 10, documentId? }` → hits with
  `rank`, `passage n of m` (where the passage sits in its document), RRF `score`, `dense #n` /
  `lexical #n` badges and the snippet; `?documentId=` preselects
  the per-document filter (the run drawer's "Indexed as a searchable document" link lands on
  `/search?documentId=`); an empty knowledge base shows an EmptyState linking to `/documents`.
- Tests: `agents-page`, `agent-run-detail` (renders `RunDetailDrawer` inside `WebSocketProvider`
  with the `FakeSocket` from `websocket-provider.test.tsx` to prove the nudge refetches),
  `agent-models-settings`, `documents-page`, `search-page`. Mount `AgentsPage` inside the same `<Routes>` pair
  App.tsx uses so `navigate('/agents/runs/:id')` really opens the drawer.

## Analytics dashboards (Phase 4, D19/D20)

- **GM wrote no chart code.** drizzle-cube renders everything: `AnalyticsDashboard` (react-grid-layout
  editor, portlet editor with its own query builder, drill-down, charts) and `AnalysisBuilder`
  (`/analytics/explore`). The kit owns the glue only: pages, hooks over `/api/analytics/*`
  (`@rocketflare/shared/analytics`), the provider wiring and the theme mapping. drizzle-cube 0.8.3 client
  API actually used: `CubeProvider` from `drizzle-cube/client/providers` (`apiOptions`,
  `queryClient`, `features`), `AnalyticsDashboard` (`config`, `editable`, `dashboardFilters`,
  `onConfigChange`, `onSave`, `loadingComponent`), `AnalysisBuilder` + `AnalysisBuilderRef`
  (`getAnalysisConfig()`), types `DashboardConfig`/`PortletConfig`/`CubeApiOptions`/
  `FeaturesConfig` from `drizzle-cube/client`, and `drizzle-cube/client/styles.css`.
- **Same-origin cookie auth**: `CubeClientProvider` passes `apiOptions = { apiUrl:
  '/cubejs-api/v1', credentials: 'include', headers: { 'X-Requested-With': 'fetch' } }` — the
  library's `CubeClient` forwards both to every `fetch` (it defaults to `include` anyway; the
  header is the kit's marker). No token. drizzle-cube runs its queries on a BUNDLED TanStack Query
  (separate React context), so the app's `QueryCache.onError` never sees a cube failure: the
  provider hands it `createCubeQueryClient()`, whose `onError` maps a `status === 401`
  (`CubeQueryError`) to `notifyUnauthorized(new ApiError(...))` → the global D20 handler. Our hooks
  rendered inside `CubeProvider` still resolve the APP client (different context) — that is why
  `DashboardLoader` can call `useAutosaveDashboardConfig` from inside it.
- **Bundle discipline**: nothing under `pages/analytics/**` or `components/analytics/**` may be
  imported from the main bundle; `App.tsx` lazy-loads the three pages and `DashboardListPage`
  deliberately imports no drizzle-cube runtime (it lists rows; the library loads with the view /
  explore chunks — Vite emits `DashboardLoader-*.js` ≈ 377 KiB gzip shared by both, plus per-chart
  chunks). `grep recharts dist/ui/assets/index-*.js` must stay at 0. `vite.config.ts` dedupes
  `recharts` and aliases `@nivo/heatmap` (an OPTIONAL peer the heat-map chunk names an export of —
  Rollup fails without it) to `lib/stubs/nivo-heatmap.tsx`, which renders a notice; install the
  package and drop the alias to enable heat maps.
- **Theme**: drizzle-cube styles itself from `--dc-*` variables; `index.css` re-points every one at
  a kit token under `:root[data-theme="rocketflare-light"], :root[data-theme="rocketflare-dark"]` (specificity
  (0,2,0) beats the library's `:root` and `html.dark` regardless of stylesheet order; the values are
  `var()`s that flip with the theme, so one block covers both). Its chart palettes decide dark from
  `data-theme="dark"` or a `dark` class on `<html>`, so `CubeClientProvider` mirrors `rocketflare-dark` into
  that class while mounted (`syncDarkClass`) — the kit's own CSS never reads `.dark`. `index.css`
  also `@source`s `node_modules/drizzle-cube/dist/client/**/*.js` (the rule for JSX-shipping
  dependencies); measured effect: the library's utilities are `dc:`-prefixed and precompiled into
  its own stylesheet, so the scan generates no drizzle-cube class — only stray-word DaisyUI
  components (`stat`, `steps`, `tooltip`, `vc`…), +6.5 KiB gzip on `index-*.css`.
- **Editing & autosave**: `DashboardLoader` keeps the config as local state (seeded from the row,
  re-seeded when the server row changes and nothing is dirty — a reset arrives that way). In edit
  mode each `onConfigChange` schedules ONE debounced whole-config `PATCH` (`DASHBOARD_AUTOSAVE_MS`
  = 1.5 s); the editor's `onSave`, leaving edit mode and unmount flush it; while dirty a
  `beforeunload` guard warns (no data router, so no `useBlocker`). Edit / rename / reset / delete /
  create / recreate are `manage Dashboard` (admin+); the route and nav are `read Analytics`.
  Template pages (`templateKey !== null`) offer "Reset to template", never delete (server: 403
  `template_page`); user pages the reverse. "Start from template" copies the config from the
  pure `src/dashboards` registry client-side (`getTemplate(key).config` → `POST /pages`).
- **Date range** is URL state (`useDashboardDateFilter`), never a store: presets emit exactly
  `'last 7|30|90 days'` or an ISO pair — an unknown relative string makes drizzle-cube DROP the
  condition and silently query all time, so anything unparseable falls back to 90 days.
  `dashboardDateFilters(config, range)` returns override copies of the `isUniversalTime` filters;
  `AnalyticsDashboard dashboardFilters` merges them by id, so a KPI with its own window is untouched.
- **Explore → Save to dashboard** (admin+): `ref.getAnalysisConfig()` becomes a portlet
  (`analysisConfig`, the canonical format) appended as a full-width `rows` entry with mirrored
  x/y/w/h (`appendPortlet`, pure) and saved with `PATCH /pages/:id`.
- Tests: `analytics-pages` (no library needed), `dashboard-view` (mocks `drizzle-cube/client`,
  `drizzle-cube/client/providers` and the stylesheet with stand-ins that fire the same callbacks;
  the debounce is asserted with real timers, `waitFor` timeout 4 s), `date-filter` (pure + hook
  URL sync via `renderHook` in a `MemoryRouter`), `cube-client-provider` (mounts the REAL
  `CubeProvider` against `stubFetch` — asserts the library's own request carries the credentials
  and header, and that a 401 reaches `setUnauthorizedHandler`; stub `window.matchMedia` first).
  Fixtures: `tests/ui/helpers/analytics.ts`.
