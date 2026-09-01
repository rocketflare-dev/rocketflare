# UI (React SPA)

React 18 + Vite + React Router 6 + TanStack Query 5 + zustand; DaisyUI 5 on Tailwind v4. Dev: Vite on
:3000 proxies `/api`,`/auth`,`/ws`,`/cubejs-api`,`/mcp` → :3001. Prod: `dist/ui` via the `ASSETS` binding.

## Layout

- `App.tsx` — providers (ErrorBoundary → QueryClient → Auth → Ability → WebSocket → Router), the
  header `<WebSocketStatus />` dot and `<ConnectionBanner />` above the routed page, and the route
  table in three tiers: public (`/login`, `/magic-link/sent`, `/invite/:token`), signed-in-without-
  tenant (`/select-tenant`, `/pending`, `/no-access` — `ProtectedRoute requireTenant={false}`), and
  the shell (`/*` — `ProtectedRoute`, `Layout` mounted ONCE, nested `<Routes>` beneath it).
- `index.css` — the design system: themes `gm-light`/`gm-dark`, semantic tokens (`--surface-*`,
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
- `lib/` — `api-client` (fetch wrapper, `ApiError`, `setUnauthorizedHandler`, `api.upload` for
  multipart — no JSON content-type), `queryClient` (module-level, 401 → handler), `query-keys`
  (factory + `cleanFilters`/`toSearchParams`; the family roots — `['invitations']`,
  `['pending-invitations']`, `['members']`, `['tenant']`… — are what `REALTIME_INVALIDATIONS` in
  `@gmgo/shared/realtime` names), `websocketClient` (singleton: `/ws?tenantId=`, jittered backoff
  1 s → 30 s, 100 ms fast path on close 1001/1012 or an "upgraded" reason, 30 s ping;
  `setFactory()` is the test seam), `navigation` (`NavigationBridge`, `navigateTo`, `hardNavigate`,
  `loginUrl`, `safeReturnUrl`), `format` (date-fns helpers), `environment`, `sse` (D17:
  `readSse(response, onEvent, { signal })` — `event:`/`data:` frame splitter that survives split
  chunks and validates each `data` with `chatStreamEventSchema`; `SseFrameBuffer`, `parseSseFrame`),
  `chatStream` (`sendChatMessage({ conversationId, content, onEvent, signal })` POSTs and streams;
  a pre-stream 503 `ai_not_configured` throws `AiNotConfiguredError`; `isAiNotConfigured()`).
- `stores/websocketStore.ts` — the one zustand store: `status | connectedAt | disconnectedAt |
  attempt | lastEvent`; written only by `websocketClient`, read by the status dot and the banner.
- `pages/` — route-level components, lazy in `App.tsx` except Home/Login/NotFound. `settings/`
  is one page with `URLTabs` (`?tab=general|people|api-keys|ai|prompts|usage`; `usage` only for
  `manage AiConfig`); `admin/` is nested routes under `AdminLayout`; `chat/ChatPage.tsx` is
  `/chat/:conversationId?` (D17, guard `read Conversation`, lazy — its chunk carries the markdown
  renderer). `public/` — static assets copied as-is.

## Conventions

- Imports: `@/ui/...` and `@gmgo/shared/...`; never import from `src/api`, `src/db` or
  `src/permissions` (the ability MATRIX is server code; the UI only unpacks rules).
- Server data lives ONLY in the query cache: `useQuery` + a key from `query-keys.ts` + a
  `@gmgo/shared` zod `schema` on `api.get`. Mutations live in the resource hook, `invalidateQueries`
  through `queryKeys`, and toast via `showSuccessToast`/`successMessage`.
- zustand is for UI state only (toasts, connection state, tab-lifetime flags). Realtime events
  never become state: the provider invalidates query roots and the hooks re-fetch ("DB is the
  truth, WebSocket is a nudge"). A new server event type gets its roots in
  `packages/shared/src/realtime.ts`, not in a component.
- Uploads: `api.upload('/api/files?scope=…', formData, { schema: uploadResponseSchema })`; check
  type/size with `@gmgo/shared/files` before sending; `<img>` avatars need an `onError` fallback
  (the object is tenant-scoped, `avatarUrl` is not).
- Tokens, not raw colours: `text-muted`, `surface-panel`, `badge-warning` — never `bg-blue-50`.
  Classes built from props are safelisted with `@source inline(...)` in `index.css`; classes
  built from data are forbidden. Heroicons only (provider marks in `components/icons` are
  `currentColor`); `<details>/<summary>` dropdowns; `<dialog>` `Modal`.
- Forms: controlled inputs + the same `@gmgo/shared` schema the server validates with; `FieldError`.
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
  `@gmgo/shared/ai/config`. The label is the upsert key `(tenant, scope, label)` — read-only on
  edit (renaming would create a second row). `apiKey` is write-only: blank on edit keeps the stored
  key (`hasCredential`); switching provider on edit requires a new key. `serviceTier: ''` clears.
  "Set default" re-posts the row with `isDefault: true` and no `apiKey`.
- `/settings` is behind `RequireGuard guard="admin"`, so the member (`read AiConfig` /
  `read Prompt`) read-only rendering of the AI and Prompts tabs is exercised component-level in
  tests only; a member has no nav path to it.
- Tests: `tests/ui/helpers/sse.ts` builds fake `text/event-stream` `Response`s (`sseResponse`,
  `streamResponse` for arbitrary chunking, `hangingSseResponse` for Stop). Bubbles remount when an
  optimistic id becomes the persisted one, so assert with `waitFor(() => getByText…)`, not `findBy`.
