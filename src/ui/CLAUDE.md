# UI (React SPA)

React 18 + Vite + React Router 6 + TanStack Query 5 + zustand; DaisyUI 5 on Tailwind v4. Dev: Vite on
:3000 proxies `/api`,`/auth`,`/ws`,`/cubejs-api`,`/mcp` → :3001. Prod: `dist/ui` via the `ASSETS` binding.

## Layout

- `App.tsx` — providers (ErrorBoundary → QueryClient → [Auth → Ability → WebSocket] → Router)
  and the route table. `Layout` mounts ONCE under `/*`; pages are nested `<Routes>` beneath it.
- `index.css` — the design system: themes `gm-light`/`gm-dark`, semantic tokens (`--surface-*`,
  `--border-*`, `--text-*`, `--tone-*`), primitives (`.surface-panel`, `.data-table`,
  `.status-badge`, `.nav-item`). Rebrand instructions are in its header comment.
- `components/` — shell: `Layout` (slots `headerStart`/`headerCenter`/`headerEnd`/`sidebarFooter`),
  `SideNav` (config-driven, `guard` flags), `EnvironmentBadge`, `ThemeToggle`, `ErrorBoundary`,
  `RequireGuard`. `components/shared/` — generic primitives only (Toast, Modal, SectionPanel…).
- `hooks/` — `useAppInfo` (`/api/health` → version/env), `useNavGuard` (the ONE place nav and
  route guards are decided), `useDebounce`, `useModalState`, `useLocalStoragePreference`.
- `lib/` — `api-client` (fetch wrapper, `ApiError`, `setUnauthorizedHandler`), `queryClient`
  (module-level, 401 → handler), `query-keys` (factory), `environment`.
- `pages/` — route-level components. `public/` — static assets copied as-is.

## Conventions

- Imports: `@/ui/...` and `@shared/...`; never import from `src/api` or `src/db`.
- Server data lives ONLY in the query cache: `useQuery` + a key from `query-keys.ts` + a
  `@shared` zod `schema` on `api.get`. Mutations sit next to the page and `invalidateQueries`.
- zustand is for UI state only (toasts, connection state, tab-lifetime flags).
- Tokens, not raw colours: `text-muted`, `surface-panel`, `badge-warning` — never `bg-blue-50`.
  Classes built from props are safelisted with `@source inline(...)` in `index.css`; classes
  built from data are forbidden. Heroicons only; `<details>/<summary>` dropdowns; `<dialog>` `Modal`.
- Forms: controlled inputs + the same `@shared` schema the server validates with; `FieldError`.
- Tests in `tests/ui/` (jsdom + Testing Library, `fetch` via `vi.stubGlobal`, no MSW); wrap
  with `tests/ui/helpers/renderWithProviders.tsx`.

## Phase 1 lands here

`hooks/useAuth.tsx` + `components/ProtectedRoute.tsx` (wrap `ShellRoutes`), `components/permissions/`
(`AbilityProvider`, `Can`, `usePermissions`), the `useNavGuard` body, `Layout` slots (`OrgSwitcher`,
`NotificationsBell`, user dropdown), `pages/{Login,MagicLinkVerify,InviteAccept,SelectTenant,Pending,Profile}`,
`pages/settings/*`, `pages/admin/*`, `setUnauthorizedHandler` → `queryClient.clear()` + `/login?returnUrl=`.
