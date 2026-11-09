# UI (React SPA)

A map of `apps/web/src/ui/`. The conventions every UI edit follows (tokens, data layer, realtime,
streaming, guards, bundle rules, tests) are `.claude/rules/ui.md`, loaded with this file. Build to
`dist/ui`, served by the `ASSETS` binding.

## Read before editing

- The run page, timeline, action panel, agent forms/outputs, `useAgents` / `useRunStream` /
  `useNavBadges` → `pages/agents/CLAUDE.md`
- Knowledge list, document viewer, search, `DocumentCard` / `DocumentLink`, `useDocuments` →
  `pages/documents/CLAUDE.md`
- The chat page or `useChat` / `useSendMessage` → `pages/chat/CLAUDE.md`
- A Settings tab (AI providers, agent models, groups, people) → `pages/settings/CLAUDE.md`
- `lib/` transports (api-client, websocket client, SSE, AG-UI streams) → `lib/CLAUDE.md`
- Anything a plugin contributes (`UiPlugin`, `src/plugins/<id>/ui/`) →
  `apps/web/src/plugins/CLAUDE.md`

## Shell

- `App.tsx` — providers `ErrorBoundary` → `QueryClientProvider` → `AuthProvider` →
  `AbilityProvider` → `WebSocketProvider` → `BrowserRouter`; dev-only `ReactQueryDevtools` in a
  `Suspense`. Route table in three tiers: public (`/login`, `/magic-link/sent`,
  `/magic-link/confirm`, `/invite/:token`), signed-in (`/cli/confirm`), signed-in-without-tenant (`/select-tenant`, `/pending`,
  `/no-access` — `ProtectedRoute requireTenant={false}`), and the shell (`/*` — `ProtectedRoute`,
  `Layout` mounted ONCE, nested `<Routes>` beneath it; each `<main>` has its own `ErrorBoundary`
  reset on pathname). Installed plugins' routes are mapped per tier inside the same `Suspense`.
- `index.css` — the design system (themes, semantic tokens, primitives, `@source` lines, safelist);
  rebrand instructions are its header comment.
- `components/` — the shell: `Layout` (slots `headerStart` = `OrgSwitcher`, `headerEnd` =
  `NotificationsBell` + `UserMenu`, `sidebarFooter`), `SideNav` (`CORE_NAVIGATION` composed with
  plugin groups by `composeNav`, filtered by `filterNavConfig`), guards (`ProtectedRoute`,
  `RequireGuard`, `AdminRoute`, `GlobalAdminRoute`), `permissions/` (`AbilityProvider` unpacks
  `session.permissions`; `IfCan`/`IfCannot`), realtime (`WebSocketProvider`, `WebSocketStatus`,
  `ConnectionBanner`), `shared/` (generic primitives + the visibility trio + `DocumentCard` /
  `DocumentLink`, all markdown-free — the eager barrel), `ai/` (`Markdown`, `ChatBubble`,
  `StatRows`, `FeedbackThumbs` — lazy chunks only).
- `hooks/` — `useAuth` (session, `status`, `selectTenant`, `logout`, `applySession`,
  `useTenancyMode`), `usePermissions` (`can/cannot/isOwnerLevel/isAdminLevel/isGlobalAdmin`),
  `useNavGuard` (the ONE place nav and route guards are decided), `useFeature` (in
  `useFeatureFlags.ts`), then one file per resource. Non-obvious ones: `useProfile` also holds the
  avatar upload (`useUploadAvatar`, `validateAvatarFile`, `AVATAR_ACCEPT`); `useGroups` is one
  `['groups']` family and `useMyGroups` is the only one a plain member may call; `useAiUsage` keys
  on the PRESET and derives the window in `queryFn`; `useSearch` is mutation-style.
- `lib/` — see `lib/CLAUDE.md`. `stores/websocketStore.ts` — the one zustand store.
- `pages/` — route components, lazy except Home/Login/NotFound. `admin/` is nested routes under
  `AdminLayout` (the `globalAdmin` guard). `public/` — static assets copied as-is.

## Routes and guards

| Route | Guard | Notes |
|---|---|---|
| `/chat/:conversationId?` | `read Conversation` | lazy, carries the markdown chunk |
| `/agents`, `/agents/runs/:runId` | `read AgentRun` | `RunPage` is its own lazy chunk |
| `/documents`, `/documents/:id`, `/search` | `read Document` | the viewer has no nav entry |
| `/settings?tab=…` | `guard="admin"` | tabs gate further — `pages/settings/CLAUDE.md` |
| `/admin/*` | `globalAdmin` | reachable with no tenant |

## Identity flow

- `useAuth` runs ONE query, `GET /auth/session`; a 401 resolves to `null` (logged out) so the query
  is never removed. Identity changes (`selectTenant`, invite accept, logout, global 401) go through
  `replaceSession()`: `setQueryData` on the session, then `resetQueries`/`removeQueries` on
  everything tenant-scoped. Never `queryClient.clear()` while observers are mounted.
- Global 401 (`notifyUnauthorized`): the handler acts only when a session WAS cached, drops it, and
  `navigateTo`s `/login?returnUrl=` unless already on a public path (D20). OAuth, dev-login and
  logout are full-page (`hardNavigate`) so the cookie round-trips cleanly; logout follows a
  `200 { endSessionUrl }`, else lands on `/login?signedOut=1`.
- `Login.tsx`: `GET /auth/methods` drives the buttons; other methods are hidden, not disabled.
  `methods.oidcOnly` shows the one SSO button and never redirects to `/auth/oidc` on its own —
  signing in is always a click. `?as=<email>` (what `pnpm bootstrap` opens) calls
  `POST /auth/dev-login` once on mount, ONLY when `methods.devLogin` is true AND the email is in
  `DEV_ACCOUNTS`; never widen the allow-list.
- No active tenant → `noTenantRoute(session)`: access request → `/pending`; memberships →
  `/select-tenant`; `signupMode === 'approval'` → `/pending`; else `/no-access`. Exception: a
  global admin opens `/admin/*` with no membership (`isAdminPath`; the bootstrap admin must approve
  the first request), and `/pending` / `/no-access` show them an "Open the admin area" link. Then
  `useNavGuard` allows ONLY `'globalAdmin'` guards, `OrgSwitcher` reads "No organisation",
  `NotificationsBell` and the Profile / Notifications menu links render nothing, and
  `WebSocketProvider` never connects (it needs a tenant id).
- Single-tenant mode (`useTenancyMode()`, D25) hides `OrgSwitcher`, `/select-tenant` (redirects
  home), org create/delete and the slug field, the `new_org` approve branch, and collapses
  `/admin/tenants` to the one detail.
- `EnvironmentBadge` + `useEnvironmentTitle` read `APP_ENV`/`RELEASE_VERSION` from the session;
  staging must look different from production.

## Feature flags admin

`/admin/feature-flags` (`pages/admin/FeatureFlags.tsx` + `FlagOverrides.tsx`, lazy) keeps the two
layers visually apart: `availableInEnvironment` is config a redeploy moves, everything else is a
click. Overrides offer three states — On / Off / Default (delete the row, follow the platform) —
and the section is absent in single mode, matching the routes. The demo `Example feature` nav item
and page are the `example-feature` PLUGIN, not shell files; its nav test lives in that plugin.
