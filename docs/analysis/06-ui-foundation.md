# 06 — UI foundation (shell, not app pages)

Sources compared:

- **Mirevue** (`~/work/mirevue`) — React 18 + Vite, DaisyUI 5 / Tailwind v4, React Router v6, TanStack Query 5, zustand. Served by a Node Hono server in prod. **Structural reference.**
- **GuideMode server** (`~/work/guidemode/apps/server`, "GM") — same UI stack, SPA served from Cloudflare Workers Static Assets. **Cloudflare substrate reference.**

Both UIs share an ancestor: `api-client.ts`, `queryClient.ts`, `Toast.tsx`, `EmptyState.tsx`, `ConfirmModal.tsx`, `AlertModal.tsx`, `WebSocketProvider.tsx`, `useAuth.tsx`, `ProtectedRoute.tsx`, `ScrollToTop.tsx` and the `vite.config.ts` proxy block are near-identical files. Mirevue is the later fork and has been through a deliberate design-system pass (UX.md); GM has ~2 years of product accretion (analytics, surveys, billing, integrations, AIVA).

**Headline verdict:** take Mirevue's `src/ui/` as the base for essentially every file in the shell — Vite config, CSS token system, App/Layout/SideNav, auth hook, guards, data layer, shared primitives, settings/admin skeletons, UI test project and the convention docs. Graft five things from GM: (1) the `RELEASE_VERSION` → session → sidebar version display, (2) host-based environment marker (`BrandName` + `utils/environment.ts`), (3) the CASL `AbilityProvider` / `usePermissions` / `IfCan` trio (Mirevue removed CASL from its UI; the kit spec wants it back), (4) `PrefetchLink`/route preloading (optional), (5) the dev-only lazy `ReactQueryDevtools`. Strip all Mirevue workshop/interview/plenary/rewired/evals/voice material and all GM analytics/survey/billing/integration material. GM's 12KB `tailwind.config.ts` safelist and its 250-line hand-written responsive-utility block are the documented anti-pattern to avoid, not something to carry.

Two facts to hold onto for the open questions: **neither repo handles 401 globally** (both rely on the session query), and **neither has a React error boundary** (GM's CLAUDE.md claims one; `grep ErrorBoundary` finds nothing in either tree).

---

## 1. Vite config

### Mirevue — `vite.config.ts`

- `root: 'src/ui'`, `build.outDir: '../../dist/ui'`, `emptyOutDir`, esbuild minify — `mirevue/vite.config.ts:26-31`.
- Dev proxy `/api`, `/auth` (http) and `/ws` (`ws: true`) → `localhost:3001`, each with the shared `onProxyError` that answers 502 instead of crashing Vite when the API restarts — `:8-17`, `:63-110`. App-specific extras: `/models`, `/ort`, `/vad` (voice model assets that must bypass Vite's module transform) — strip.
- Tunnel support: `PUBLIC_URL` (injected by `cfld`) → `allowedHosts` + `hmr: { protocol: 'wss', clientPort: 443 }` — `:22`, `:35-40`.
- Watch allowlist (`src/ui`, `src/shared`, the three config files) so server/migration/doc edits don't churn Vite — `:41-62`. Keep; it is what makes a single-package repo pleasant.
- Aliases `@` → `src/ui`, `@shared` → `src/shared`; `dedupe: ['react', 'react-dom']` — `:112-118`. Note the alias asymmetry documented in `.claude/rules/code-quality.md:26`: in vitest `@` → `src` (tests import `@/ui/...`), in vite `@` → `src/ui`.
- No `define`/env exposure. `import.meta.env` is used only for `DEV` (`SideNav.tsx:71`, `Login.tsx:257`) and one `VITE_WS_URL` override (`lib/websocketClient.ts:62`).

### GM — `vite.config.ts`

- Same proxy trio plus `/cubejs-api`, `/health`, `/learn` (→ :3002) — `guidemode/apps/server/vite.config.ts:82-118`. Strip.
- `allowedHosts: ['.guidemode.dev']` (whole dev zone) and `HMR_HOST` env → `origin`/`hmr` — `:73-81`. Same idea as Mirevue's, one env var name apart.
- `splitVendorChunkPlugin()` + `manualChunks` for recharts / drizzle-cube — `:30`, `:49-65`; `ANALYZE=true` toggles sourcemaps + no-minify for `source-map-explorer` — `:25`, `:47-48`. The analyze switch is worth keeping as a comment; the chunks are app-specific.
- MDX (`@mdx-js/rollup` + remark gfm/frontmatter) — `:31-34` — for the Learn content, since moved to a standalone app (`App.tsx:225`). Strip.
- **`vite-plugin-node-polyfills` — why:** added alongside MDX for the learn content (`docs/learn/03-build-system.md:333-346` shows the original `include: ['buffer','process']`); since trimmed to `globals: { global: true, Buffer: false, process: false }` (`:35-41`), i.e. only a `global` shim survives for some browser dep. Nothing in the kit needs it. Drop; if a dep later wants `global`, add a one-line `define: { global: 'globalThis' }` instead.
- React pinned to `node_modules/react` via alias — `:124-127` — a pnpm-workspace duplicate-React workaround; irrelevant in a single package.
- Two `index.html`s: root `index.html` (`data-theme="light"`, `src="/src/ui/main.tsx"`) is stale; `src/ui/index.html` is the one Vite uses (`root: 'src/ui'`). Kit ships only `src/ui/index.html`.

**Verdict:** Base Mirevue. Add GM's `ANALYZE` switch as a commented option. Strip `/models`, `/ort`, `/vad`, MDX, polyfills, manualChunks. Env exposure convention: no `VITE_*` besides an optional `VITE_WS_URL`; runtime facts (version, environment) come from the server session, not the build (see §4 — the same static bundle is served to every Workers environment, so build-time env cannot distinguish them; `guidemode/.../utils/environment.ts:3-7` says exactly this).

---

## 2. Tailwind v4 + DaisyUI 5

### PostCSS / config files

Identical in both: `postcss.config.js` = `@tailwindcss/postcss` + `autoprefixer`. `tailwind.config.ts` is safelist-only because v4 moved content/plugins/theme into CSS:

- Mirevue: 15 entries — the `alert-*`/`badge-*`/`btn-*` variants that `Toast`/`AlertModal`/badges build from a prop — `mirevue/tailwind.config.ts:12-33`.
- GM: ~570 entries — `guidemode/apps/server/tailwind.config.ts:22-598` — raw palette utilities (`bg-blue-50`, `text-purple-700`…), `dc-*` drizzle-cube classes, and hundreds of plain layout/spacing utilities (`flex`, `p-4`, `md:grid-cols-2`). Plus `index.css:26-272` hand-redeclares responsive utilities under `@layer utilities` ("Force responsive utilities that are missing in Tailwind v4 + DaisyUI"). Both are symptoms of scanning a `node_modules` package (`@source "../../node_modules/drizzle-cube/..."`, `index.css:24`) and of classes assembled from strings. Do not carry either; the kit's rule is "safelist only classes built from props, never from data".

### CSS entry — the real design system lives here

Mirevue `src/ui/index.css` (891 lines, ~620 generic):

- `@import "tailwindcss"; @plugin "daisyui"; @plugin "@tailwindcss/typography"; @source "../**/*.{js,ts,jsx,tsx}"` — `:2-8`.
- `@theme` sets `--font-sans` (Hanken Grotesk Variable) and `--font-mono` (IBM Plex Mono) — `:26-31`; fonts self-hosted via `@fontsource` imports in `main.tsx:3-6`.
- Two DaisyUI themes as `@plugin "daisyui/theme"` blocks: `exec-light` (`default: true`) `:34-75`, `exec-dark` (`prefersdark: true`) `:78-115`. Every hex is annotated with its palette tone (`/* aubergine-800 */`) and derived from `design/palette.json` via `scripts/build-palette.ts`; `--depth: 0; --noise: 0` for flat controls.
- Per-theme semantic surface/border/text tokens (`--surface-app/nav/header/panel/raised/inset/hover/active`, `--border-subtle/default/strong/control`, `--text-primary/secondary/muted`, `--focus-ring`, `--tone-*-surface/border`) — `:118-220`.
- Theme-independent shape/motion tokens (`--radius-control/panel/popover`, `--control-height-*`, `--space-*`, `--dur-*`, `--row-height`, `--panel-pad`) — `:222-245`; `[data-density="compact"]` overrides — `:316-319`.
- `@layer base`: 15px body, tabular numerals on `th/td`, one `:focus-visible` ring, thin scrollbars, `prefers-reduced-motion` kill-switch — `:248-313`.
- `@layer components` primitives: `.btn`/`.card` flattened, `.surface-panel`, `.surface-inset`, `--border-control` on inputs (WCAG 1.4.11), `.data-table` (sticky mono uppercase head, hairline rows, `[data-selected]`), `.status-badge[data-status=…]`, `.text-secondary`/`.text-muted`, `.app-canvas/.app-nav/.app-header`, `.nav-item[data-active]`, `.nav-group-label` — `:322-620`.
- App-specific tail to strip: `.rewired-content*` `:632-715`, plenary keyframes `:717-830`, sequencing drag `:830-868`, and the `prep/live/complete/archived` status vocabulary `:208-230`.

GM `src/ui/index.css` (785 lines, ~60 generic): two themes with bare hexes and no `prefersdark` (`:313-363`); the v3 `border-color: currentcolor` compat shim (`:365-381` — Mirevue does not need it because every border names a token); a drizzle-cube modal z-index override (`:383-398`); `.main-gradient` (`:401-406`); ~215 lines mapping DaisyUI vars onto `--dc-*` (`:408-624`); ~160 lines of Prism syntax theming (`:625-785`). Only `.main-gradient` (auth-page background) survives, and Mirevue has its own at `:622-630`.

### Theme switching

- Pre-hydration script in `index.html` sets `data-theme` before React mounts. Mirevue **validates** the stored value and falls back to `prefers-color-scheme` — `mirevue/src/ui/index.html:19-31`; GM accepts any string (`guidemode/.../src/ui/index.html:38-44`), which is how a stale value once made the toggle a no-op.
- `ThemeToggle` — Mirevue's `getInitialTheme()` normalises the same way and a single effect writes both DOM attribute and `localStorage['theme']` — `mirevue/src/ui/components/ThemeToggle.tsx:9-21`. No store; the DOM attribute *is* the state. Tested in `tests/ui/theme-toggle.test.tsx`.
- Neither repo has a "system" option or cross-tab sync; fine for the kit.

**Verdict:** Base Mirevue `index.css` wholesale, renamed from `exec-light/dark` to neutral kit names (`app-light`/`app-dark`) with a single find/replace also covering `index.html`, `ThemeToggle.tsx`, `contrast-spec.ts` and tests. Strip the app-specific tail. Decide whether to ship the palette pipeline (`design/palette.json`, `scripts/build-palette.ts`, `scripts/lib/roles.ts`, `scripts/lib/contrast*.ts`, `tests/ui/contrast.test.ts`) — see Open Questions. GM contributes nothing here except the reminder that `@source`-ing `node_modules` leads to safelist sprawl.

---

## 3. App shell: `main.tsx` / `App.tsx` provider stack

### Mirevue — `App.tsx:438-452`

```tsx
<QueryClientProvider client={queryClient}>
  <AuthProvider>
    <WebSocketProvider>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ScrollToTop />
        <AppRoutes />          {/* one <Suspense fallback={<LoadingIndicator size="xl" centered/>}> */}
        <ToastContainer />
      </BrowserRouter>
    </WebSocketProvider>
  </AuthProvider>
</QueryClientProvider>
```

- `queryClient` built once at module scope via `initializeQueryClient()` (`:93`) so non-React code (`websocketStore`) can import it.
- No CASL, no Helmet, no devtools, no error boundary. `main.tsx` is 19 lines: fonts, `./index.css`, `StrictMode`.

### GM — `App.tsx:664-686`

`HelmetProvider → QueryClientProvider → AuthProvider → AbilityProvider → WebSocketProvider → AppContent (+ToastContainer)`, with `ReactQueryDevtools` lazily imported and rendered only under `import.meta.env.DEV` (`:5-9`, `:676-682`). `AppContent` owns a ⌘K listener + `SearchModal` (`:146-169`) and `useStagingTitle()` (`:151`). `PageLoader` uses `fallback={null}` (`:142-144`) — pages own their skeletons; Mirevue uses one visible spinner. Helmet is used by exactly 3 files (`usePageMeta.tsx` for the public Learn pages); not needed for an authenticated SaaS shell.

### Layout / top bar / sidebar

Mirevue `components/Layout.tsx:129-216`: DaisyUI `drawer lg:drawer-open` on `.app-canvas`; sticky `h-14` `.app-header` with mobile hamburger, **`OrgSwitcher`** (`:69-108` — org name links home, `<details>` dropdown lists other tenants with role badges, calls `selectTenant`), `WebSocketStatus`, `NotificationsBell`, `ThemeToggle`, user menu (`<details>/<summary>` avatar → Profile / Settings (admin) / Sign out, `:161-203`). App-specific: `TopSearch` (`:28-65`), `WorkshopCrumb` (`:112-127`).

Mirevue `components/SideNav.tsx`: config-driven `NavItem | NavGroup` with `adminOnly` / `globalAdminOnly` flags (`:25-76`; the `/evals` entry is spliced in only under `import.meta.env.DEV`, `:70-73`); collapse state persisted to `localStorage['sideNavCollapsed']` (`:95-101`); admin derived from the current membership role incl. `support` (`:103-108`); closes the mobile drawer on navigate (`:115-121`); items styled with the `.nav-item[data-active]` primitive and a hover tooltip when collapsed (`:132-158`); brand row shares the header's `h-14` + bottom border so the seam is continuous (`:166-180`). App-specific: `WorkshopNav` context switch (`:184-191`, `useWorkshopScope`, `pages/workshops/sections`).

GM `components/AdminLayout.tsx:93-160`: full-width `DesktopTopNav` above a `drawer md:drawer-open`, separate mobile `TopNavBar`, hover-revealed collapse button (`:150-160`), and a `SurveyOnlyLayout` variant (`:22-91`, app-specific). Differences worth noting:
- GM's `SideNav.tsx:28` does `import { can } from '../../api/middleware/permissions'` — **UI importing server code**. Anti-pattern; the kit must gate nav via `usePermissions()` only.
- GM injects "Global Admin" into the Settings group at runtime (`:239-256`) instead of a `globalAdminOnly` flag; Mirevue's flag is cleaner.
- GM shows the **deployed release version** at the foot of the nav — `SideNav.tsx:402-409` (`v{version}` from `useAuth().version`). Plumbing: `wrangler.toml:8-9` (`RELEASE_VERSION = "dev"`, overridden by CI `wrangler deploy --var RELEASE_VERSION:<tag>`) → `types/env.ts:41` → session response `routes/auth/session-management.ts:56,159` → `useAuth.tsx:61,345`. Mirevue has none of this. **Port it.**
- GM `BrandName.tsx:17-43` renders a STAGING/PREVIEW badge decided by hostname (`utils/environment.ts:20-26`: `alpha.guidemode.dev` → staging, `*.workers.dev` → preview), click-to-hide via the tiny `stores/stagingMarker.ts`, and `hooks/useStagingTitle.ts:15-39` keeps the tab title prefixed with a `MutationObserver`. **Port** as `EnvironmentBadge` with the hostname list made configurable; it exists precisely because a Workers static bundle is identical across environments.
- GM `TenantSelector.tsx` (157 lines) is a hand-rolled dropdown with a backdrop `<div onClick>` and inline SVG paths; Mirevue's `OrgSwitcher` does the same job in 40 lines with `<details>` and heroicons. Use Mirevue's.
- GM `TopNavBar.tsx:76-80` uses `tabIndex={0} role="button"` divs for dropdowns — exactly what Mirevue's `src/ui/CLAUDE.md:21` forbids ("DaisyUI dropdowns use the `<details>/<summary>` pattern (biome rejects tabIndex divs)").

**Verdict:** Base Mirevue `App.tsx`, `Layout.tsx`, `SideNav.tsx`. Insert `AbilityProvider` between Auth and WebSocket (from GM). Add GM's DEV-only lazy devtools. Add version footer + environment badge from GM. Replace `TopSearch`/`WorkshopCrumb` with an empty `flex-1` slot (UX.md §4 says the top bar "is never left empty" — the kit should leave a documented slot, not a fake search). Drop Helmet, ⌘K/SearchModal, WalkthroughTour.

---

## 4. Routing

### Route tree and guard composition

Mirevue `App.tsx:95-436`: a **flat** lazy route table; every protected route is written as `<ProtectedRoute><Layout><Guard?><Page/></Guard></Layout></ProtectedRoute>`, nested `<Route>` children for section layouts (`/admin/*` `:122-142`, `/settings/*` `:375-430`), `<Route path="*" element={<NotFound/>}/>` last. Public: `/login`, `/magic-link/verify`, `/invite/accept`. Full-screen routes (plenary, graphs) skip `<Layout>` (`:329-364`). Every page is `lazy()` (`:16-91`), one `Suspense` at the top of `AppRoutes` (`:97`).

GM `App.tsx:166-662`: `/*` → `ProtectedRoute → AdminLayout → nested <Routes>` (`:228-233`), so the layout mounts once; core pages (`Home`, `Login`, `NotFound`, `SelectTenant`) are eager imports (`:24-28`) for first paint; every lazy page wrapped in its own `<PageLoader>`. `/onboarding` sits *outside* `ProtectedRoute` to avoid a redirect loop (`:215-223`).

Both are readable; Mirevue's per-route guards are more explicit, GM's single mounted layout avoids remounting the sidebar on navigation. For the kit, take Mirevue's table but adopt GM's shape for the protected subtree so `Layout` (and the websocket-driven header widgets) mount once — see the proposed `App.tsx` in the file list.

### Guards

- `ProtectedRoute` — Mirevue `components/ProtectedRoute.tsx:10-36`: spinner while `loading`; `account_blocked` → `/login?error=account_blocked`; unauthenticated → `/login?returnUrl=<path+search>`; **`tenants.length === 0` → `/pending`** (the invitation-only "no organisation yet" holding page). GM `:11-51` instead consults an onboarding-status query and redirects owners to `/onboarding` only from `/` (direct links skip it).
- `AdminRoute` — Mirevue `:19-23` accepts `owner | admin | support | user.isGlobalAdmin` and explains why (global admins hold `manage all` server-side); GM `:17` only `owner | admin`. Mirevue's is correct.
- `GlobalAdminRoute` — Mirevue `:14-26`, gated on `user.isGlobalAdmin`, comment stresses it is cosmetic (server enforces). GM gates inline in `pages/GlobalAdmin/index.tsx:13-16`.
- CASL route guard — GM `pages/Settings/index.tsx:33-49` defines a local `ProtectedRoute({ action, subject })` that redirects to `/settings/general`. This is the right shape for a kit `RequireAbility` component.

### Code splitting / preloading

GM `components/PrefetchLink.tsx` + `lib/route-preload.ts:10-80` preload a route's chunk on hover. The map duplicates `App.tsx`'s lazy imports by hand (drift risk; the file even says "mirrors App.tsx"). Optional for the kit; if shipped, derive the map from one shared `routes.ts` rather than two lists.

### Auth pages

- `Login` — Mirevue `pages/Login.tsx` (286 lines): URL-error → message map (`:22-30`, cleaned from the URL after read `:46-52`), `authMethodsQueryOptions()` decides which OAuth buttons are enabled (`:57-62`), magic-link form validates with the **same `@shared` zod schema the server uses** (`:106`), DEV-only quick-login buttons hitting `/auth/dev-login` (`:14-20`, `:257-283`), branded card with `LogoMark` + `ThemeToggle` header. GM's (485 lines) adds 8 providers, a `mode=desktop` CLI flow and a floating game. Base Mirevue; make the provider list data-driven from `/auth/methods`.
- `MagicLinkVerify` — near-identical in both; Mirevue `:25-51` POSTs the token and hard-navigates to `redirectUrl`. Keep.
- `SelectTenant` — **different purposes**: Mirevue's is a workspace switcher (`:12-36`); GM's is the CLI/desktop key-generation flow (`redirect_uri` → `/auth/cli/generate-key`, `:29-48`). Kit ships Mirevue's; GM's is app-specific.
- `Pending` — Mirevue `pages/Pending.tsx:14-34`: holding page for a signed-in user with no tenant, showing `accessRequest.status` (pending/rejected + review note). Pairs with the `/admin/requests` queue. Ship if the kit is invitation-only (Open Question).
- `InviteAccept` — Mirevue `:41-56`: `useMutation` → hard redirect on success, `requiresAuth` → login with `returnUrl`. GM equivalent uses `useAcceptInvitation` hook. Same shape; keep Mirevue.
- `NotFound` — Mirevue 15 lines; GM 92 lines with `FloatingProviderGame` and Press Start 2P. Mirevue.
- Onboarding — GM `pages/Onboarding/OnboardingWizard.tsx` (484 lines) + `components/wizard/MultiStepWizard.tsx` (272 lines, marketing "context" side panel) + `hooks/useOnboarding.ts` (status/dismiss/reset) — thoroughly GM-specific. If the kit wants a first-run flow, build it on Mirevue's `Wizard`+`Stepper` and GM's status/dismiss API shape.

**Verdict:** Base Mirevue routes/guards/auth pages. Add `RequireAbility` from GM's settings guard. Preloading optional.

---

## 5. Auth on the client

Mirevue `hooks/useAuth.tsx`:

- Session query `GET /auth/session` through `api.get(..., { schema: sessionResponseSchema })` (`:66-71`), `staleTime` 5 min, `retry: 1`; the schema lives in `src/shared/auth.ts:48-66` and already carries `permissions: z.array(z.unknown())` (serialized CASL rules) even though Mirevue's UI ignores it.
- `selectTenant` mutation → `localStorage['selectedTenantId']` → **hard reload to `/`** (`:73-82`) so every cache/socket re-initialises.
- Auto-selection effect with a `useRef` loop guard (`:57-59`, `:97-126`): prefer the stored tenant if still a member, else the first.
- **First-paint fix**: derive `currentTenantId`/`tenantUser` from the *stored* tenant when it is a valid membership, so a member does not flash the admin nav while the server switch lands (`:185-200`). Keep the comment; it documents a real bug.
- `logout` → `POST /auth/logout`, clears `selectedTenantId` and `queryClient.clear()` (`:128-134`). Login functions are full-page redirects to `/auth/<provider>?returnUrl=` (`:136-149`); magic link is a POST with `showErrorToast: false` (`:151-169`).
- Exposes `accessRequest`, `rewiredEnabled` (app-specific — strip), `error: 'account_blocked'`.

GM `hooks/useAuth.tsx`: same skeleton with raw `fetch` everywhere (no schema, `:116-132`), inline duplicated types (`:5-96`, `permissions: any[]`), `subscription`/`isSurveyOnly`/`billingEnabled` (strip), **`version`** (`:61`, `:345` — keep), eight `loginWith*` functions (`:252-290`).

401 handling: `ApiError.isAuthError()` exists in both clients (`mirevue/.../api-client.ts:53`, GM `:48`) but nothing calls it; there is no `QueryCache.onError`, no fetch-wrapper redirect. A stale session surfaces as failed queries until the 5-minute session refetch. Open Question.

CSRF: no client header. Protection is server-side origin checking — `mirevue/src/api/middleware/csrf.ts:32-57` (Origin allowlist + `Sec-Fetch-Site`; Bearer requests exempt). Cookies are `HttpOnly; SameSite=Lax` (`routes/auth/helpers.ts:39`). The UI only needs `credentials: 'include'`, which `api-client` already sets.

**Verdict:** Base Mirevue `useAuth`. Add `version` and expose `permissions` (typed as `RawRuleOf<AppAbility>[]`) for the `AbilityProvider`. Strip `rewiredEnabled`; keep `accessRequest` only if `/pending` ships. Collapse the `loginWith*` family into `loginWith(provider: AuthProvider, returnUrl?)`.

---

## 6. CASL on the client

Mirevue removed CASL from the UI on purpose — `.claude/rules/ui.md` (via `src/ui/CLAUDE.md:22`): "No framer-motion/recharts/CASL here; admin gating uses `role`/`isGlobalAdmin` from `useAuth`". The kit spec asks for `@casl/react`, so this is the one place GM is the base:

- `contexts/AbilityContext.tsx:37-52` — `createMongoAbility(auth.permissions)` memoised on `[authenticated, permissions]`, empty ability when logged out; exports `Can = createContextualCan(...)` and `useAbility()`.
- `hooks/usePermissions.ts:9-71` — `can/cannot` plus named helpers (`canManageMembers`, `isAdminLevel`, `getUserRoleLevel`…). The named helpers are app vocabulary; keep only `can`, `cannot`, `isGlobalAdmin`, `isOwnerLevel`, `isAdminLevel`.
- `components/permissions/IfCan.tsx` — `<IfCan action subject fallback>` / `<IfCannot>`. Plus `components/permissions/CLAUDE.md` — accurate, generic, worth porting nearly verbatim.
- Types come from `@guidemode/types` (`Actions`, `Subjects`, `AppAbility`); in the kit these live in `src/shared/permissions.ts` (Mirevue already has the server side of this — see 01-auth).

**Verdict:** Graft GM's trio onto Mirevue's shell. Keep Mirevue's role-based `AdminRoute`/`GlobalAdminRoute` for coarse routing and add `RequireAbility` for fine-grained pages; decide the split explicitly (Open Question). Never import from `src/api` in `src/ui` (GM `SideNav.tsx:28`).

---

## 7. Data layer conventions

### Fetch wrapper — `lib/api-client.ts`

Mirevue (`:16-259`) is a strict superset of GM's:
- `ApiError { status, code, details }` with `isStatus/isClientError/isServerError/isAuthError`; `details` is the parsed error body as `unknown` so a 409 "soft gate" can be rendered with the server's counts (`:21-35`).
- `request()` always sends `credentials: 'include'` + JSON content-type (`:142-149`), handles 204/empty bodies, and **optionally zod-parses the response** via `schema` (`:176-188`) with a descriptive failure message.
- Verb helpers with toast defaults: GET → no error toast, mutations → error toast on (`:200-259`); `showSuccessToast + successMessage` opt-in. `showToast` is re-exported here so hooks need one import.

### Query client and keys — `lib/queryClient.ts`

Identical defaults in both: `staleTime` 5m, `gcTime` 10m, `retry: 2` with exponential backoff capped at 30s, `refetchOnWindowFocus: false`, `refetchOnReconnect: 'always'`, mutations `retry: 1` (`mirevue:11-31`). Exported as a module-level `let queryClient` initialised by `initializeQueryClient()` so the websocket store can call `invalidateQueries` outside React.

`queryKeys` factory (`mirevue:34-284`): `{ domain: { all, list(filters), detail(id) } }` with filters `JSON.stringify`ed into the key; nested keys deliberately share prefixes so one invalidation covers a family (comments at `:182-187`, `:193-195`). Generic entries: `auth`, `notifications`, `admin`, `members`/`people`, `keys`, `invitations`, `profile`, `tenantSettings`. Everything from `workshopSessions` down is app-specific.

`websocketHelpers` (`mirevue:289-309`): `invalidateFromWebSocket(keys)` with `refetchType: 'all'`, `updateQueryFromWebSocket`. GM additionally has `addItemToList/updateItemInList/removeItemFromList` (`:169-197`) — unused-looking list mutators; skip.

### Where queries live

- Mirevue: **`queryOptions()` factories in `lib/query-options.ts`** (1276 lines), each pairing a URL with its `@shared` schema; pages call `useQuery(xQueryOptions(...))` directly (94 page files vs 3 hooks). Mutations are declared inline in pages with `api.post/patch/delete` and `queryClient.invalidateQueries({ queryKey: queryKeys.x.all })` (e.g. `pages/settings/ApiKeys.tsx:23-40`, `pages/Profile.tsx:41-51`, `pages/admin/TenantDetail.tsx:19-47`).
- GM: **hooks-per-resource in `hooks/use<Domain>.ts`** (51 hook files vs 5 pages calling `useQuery`), each with raw `fetch` + manual `!response.ok` throw (`hooks/useApiKeys.ts:11-26`, `hooks/useSettings.ts:14-27`) and `onSuccess/onError` pass-through options; `useTeamMembers.ts:54-77` shows `placeholderData: previous` for paginated lists. The docs (`.claude/rules/server/ui.md:45-61`) even show a ky-style `api.get(...).json()` that does not match the real client — the hooks predate `api-client`.

Optimistic updates: rare in both (Mirevue's sequencing board `useSequencingBoard.ts:105-170`, GM `useAgentSessions.ts:225`); not a shell concern.

Devtools: only GM mounts `@tanstack/react-query-devtools` (lazy, DEV-only). Mirevue has it in devDependencies but never renders it.

Pagination metadata differs: Mirevue `{ page, pageSize, total, totalPages }` (`components/shared/PaginationControls.tsx:3-8`), GM `{ limit, offset, total, hasMore }` (`:3-8`). Pick one for the kit's `src/shared` list-response schema (Open Question; Mirevue's `page/pageSize` is what its `People`/admin endpoints already return).

**Verdict:** Base Mirevue: `api-client` (with `schema`), `queryClient` defaults + `queryKeys` factory trimmed to the generic domains, `query-options.ts` trimmed to auth/notifications/profile/people/keys/invitations/admin/tenant-settings. Convention for the kit: *queries* are `queryOptions()` factories validated against `src/shared`; *mutations* live next to the page (or in a small `hooks/use<Resource>.ts` when reused ≥2 places) and invalidate through `queryKeys`. Add GM's DEV devtools mount.

---

## 8. State: zustand vs query cache

Both repos are disciplined here: server data is only ever in the TanStack cache; zustand holds ephemeral client state.

- Mirevue: two stores. `stores/websocketStore.ts` (289 lines) — connection state, `lastEvent`, an **entity → query-key invalidation map** (`:103-150`) and `RESYNC_KEYS` refetched after reconnect (`:81-91`), plus two pieces of deliberately non-persisted live-session state (app-specific). `components/shared/Toast.tsx:41-54` — the toast queue, exposed as `showToast()` callable outside React.
- GM: `websocketStore.ts` (723 lines, with `eventHistory`, active-session tracking, sync progress — app-specific), `syncStore.ts` (integration sync progress), `stagingMarker.ts` (18 lines, keep), a zustand store inside `useDateRangeFilter.ts`, and the same Toast store. `hooks/useLocalStoragePreference.ts` (`useBooleanPreference`, `useStringPreference`, `useStoredSettings`) is a nice generic utility for per-user UI prefs (collapsed nav, table density) — port it and use it for `sideNavCollapsed` instead of the ad-hoc `localStorage` calls in both `SideNav`s.

**Verdict:** Kit ships three stores: `websocketStore` (Mirevue's, entity map reduced to `notification | invitation | member | tenant`), `toastStore` (inside `Toast.tsx`), `environmentMarker` (GM's `stagingMarker` renamed). Rule in `ui.md`: "zustand for connection state, toasts and tab-lifetime UI flags; never for anything the server can return".

---

## 9. Shared components

Mirevue `components/shared/index.ts:1-44` is the manifest. Generic vs app-specific:

| Keep (generic) | Notes |
|---|---|
| `Toast.tsx` (`ToastContainer`, `showToast`, `useToastStore`) | DaisyUI `alert-*`, auto-dismiss, `role="alert"`; tested `tests/ui/toast.test.tsx` |
| `EmptyState.tsx` (+`EmptyStateCard`) | icon/message/description/action, 3 sizes; Mirevue uses `.text-muted` tokens, GM uses `text-base-content/60` (off-ramp per UX.md §2) |
| `PaginationControls.tsx` | "Showing X to Y of Z" + prev/next; see pagination shape question |
| `SearchInput.tsx` | debounced, clear button, `aria-label` |
| `LogoMark.tsx` | inline SVG in `currentColor` — replace geometry, keep pattern |
| `ColumnShell.tsx` + `Rail.tsx` | section rail (vertical ≥lg, pills <lg), config-driven, `data-active`; tested `tests/ui/column-shell.test.tsx`. **Should replace the three copy-pasted navs** (`SettingsLayout.tsx:41-99`, `admin/AdminLayout.tsx:12-66`, GM `SettingsNav`/`ProfileNav`/`GlobalAdminNav`) |
| `InspectorPanel.tsx` + `InspectorOutlet.tsx` | right-docked slide-over driven by a nested route; Escape/backdrop/swipe close (`:43-60`); tested |
| `Wizard.tsx` + `Stepper.tsx` | presentational multi-step chrome, caller owns the draft; tested `tests/ui/wizard.test.tsx`, `stepper.test.tsx` |
| `Markdown.tsx` | react-markdown + gfm with GitHub-compatible heading slugs; optional |
| `FileDropZone.tsx` (`useFileDropTarget`, `usePreventFileDropNavigation`) | the four non-obvious HTML5 drop details in one hook; optional |
| Root `components/`: `ConfirmModal.tsx`, `AlertModal.tsx`, `LoadingIndicator.tsx`, `ScrollToTop.tsx`, `URLTabs.tsx`, `NotificationsBell.tsx`, `ConnectionBanner.tsx`, `WebSocketStatus.tsx`, `ThemeToggle.tsx` | `LoadingIndicator` — take Mirevue's DaisyUI spinner (`:21-33`), not GM's branded SVG with hard-coded `#FF8800`/`#22C55E` (`:36,46`). `ConfirmModal`/`AlertModal` are byte-identical across repos and use `div.modal.modal-open`, not `<dialog>` — no focus trap (a11y note) |
| Hooks: `useModalState.ts` (`useModalState`, `useModalWithData`), `useDebounce.ts` | identical in both |

Strip from Mirevue `shared/`: `Agent*`, `Document*`, `DomainBadges`, `EngagementBadge`, `InterviewStatusBadge`, `LifecycleNotice`, `ModelBadge`, `PeopleImportDialog`, `UploadQueueList`, `FileTypeIcon`.

From GM, port: `hooks/useLocalStoragePreference.ts`; `PrefetchLink` (optional); `pages/GlobalAdmin/components/AdminPanel.tsx:21-92` (`AdminPanel`, `AdminSkeletonRows`, `AdminPanelSkeleton` — a good generic "section panel + matching skeleton" pair; restyle onto `.surface-panel`). GM's `PageHeader` (breadcrumbs/badge/avatar/actions, `:44-159`) is useful but its `text-3xl font-bold` title (`:140`) contradicts UX.md's "no enormous headings" — adopt the API, restyle. GM's `mobile/*` (`ResponsiveCard` with `hover:shadow-md`, `FilterDrawer`, `MobileActionSheet`) and `URLTabs` swipe gestures are nice-to-have, not shell.

**Forms:** neither repo uses react-hook-form or any form library. Pattern is controlled `useState` fields + DaisyUI `form-control`/`label`/`input input-bordered` + `schema.safeParse()` from `@shared` before submit (Mirevue `Login.tsx:106`, `People.tsx:7-15` importing `createInvitationSchema`/`updatePersonSchema`). GM's `InviteForm.tsx:15-16` hand-rolls an email regex instead. Kit convention: plain React + shared zod schemas; a `FieldError` helper is the only abstraction worth adding.

**Icons:** `@heroicons/react/24/outline` everywhere in Mirevue; GM mixes heroicons with inline `<svg><path d="M19 21V5…">` strings (`TenantSelector.tsx:48-55`, `SettingsNav.tsx:49`, `ProfileNav.tsx:13`). Kit rule: heroicons only; provider brand icons in `components/icons/ProviderIcons.tsx` (Mirevue) — GM's `integrations/IntegrationIcons.tsx` has the same for 8 providers.

---

## 10. Settings / admin skeletons

### Mirevue (base)

- `pages/settings/SettingsLayout.tsx:23-39` config nav with `adminOnly`; `:101-123` renders title + nav + `<Outlet/>`. Route table `App.tsx:375-430` wraps each child in `AdminRoute` and keeps `/settings/members` as a redirect after the rename to People.
- `pages/settings/People.tsx` (708 lines) — the unified directory (members + directory people + pending invitations off one endpoint), filter tabs, `SearchInput` + `useDebounce`, `PaginationControls`, add/edit in an `InspectorPanel`, role change / remove / resend / import. Generic once the `functionalArea`/`seniority`/`managerEmail` fields (`:77-93`) are stripped; ~450 lines remain.
- `pages/settings/ApiKeys.tsx` (221 lines) — create (name → plaintext shown once with copy), list active/revoked, revoke via `ConfirmModal`. Generic.
- `pages/Profile.tsx` (208 lines) — name/username form (invalidates `profile.me` + `auth.user`) and connected-login providers with link/unlink. Generic.
- `pages/admin/AdminLayout.tsx` — Requests / Organisations / Users nav with a pending-count badge (`:27-28`); `AccessRequests.tsx` (approve into new/existing org, reject), `TenantList.tsx`/`UserList.tsx` (search + filter tabs + table), `TenantDetail.tsx` (rename, suspend, **enter/leave support access** `:31-47` which adds a real `support` membership and switches tenant), `UserDetail.tsx`. All generic; `AccessRequests` only if invitation-only.
- Strip: `AIProvider`, `AgentModels`, `RewiredSettings`, `TenantSetup`.

### GM (mine for shape, not code)

- `pages/Settings/index.tsx` — nested `<Routes>` with per-route CASL guard; `SettingsNav.tsx` (377 lines) with `requiredPermission`/`requiresBilling` flags. The **permission-flag-on-nav-item** idea is worth carrying into `Rail`'s item type.
- `pages/Profile/` — four sub-pages (General, Authentication, Keys, Notifications). `KeysProfile.tsx` and `Settings/KeySettings.tsx` are 95% duplicate (268/266 lines) differing by a `userOnly` flag (`hooks/useApiKeys.ts:11-26`). The kit can support **personal vs tenant API keys** with one `ApiKeysPanel({ scope })` if the API exposes `?userOnly=`; decide (Open Question).
- `pages/Settings/PermissionsSettings.tsx` — renders the current user's CASL matrix per resource; a small, useful "what can I do here" page once the resource list comes from `src/shared/permissions`.
- `pages/Settings/GeneralSettings.tsx` (559 lines) — tenant name, retention toggles, create/delete tenant, restart onboarding; `SettingToggle`/`SettingInput` row components (`components/SettingToggle.tsx`, `SettingInput.tsx`) are a good "label + description + control" primitive. Mirevue has no tenant General page — add one (name/slug, danger zone) using these rows.
- `pages/GlobalAdmin/` — same three screens as Mirevue's admin minus access requests, with `AdminPanel` skeletons.

**Verdict:** Base Mirevue pages; rebuild all three side-navs on `ColumnShell`/`Rail`; add a tenant **General** settings page (GM shape, Mirevue tokens) and optionally **Permissions**; unify API keys as one panel with a scope prop.

---

## 11. Realtime wiring (UI side only)

- `components/WebSocketProvider.tsx` — identical logic in both: connect once `authenticated && currentTenantId`, singleton client, never disconnect on unmount (`mirevue:11-38`). GM's copy has five `console.log`s (`:16-42`) — strip.
- `lib/websocketClient.ts` singleton: same-origin `/ws?tenantId=` with optional `VITE_WS_URL` (`mirevue:62`, GM `:51`), backoff reconnect, ping/pong; tested `tests/ui/websocket-backoff.test.ts`.
- `stores/websocketStore.ts` bridges events → `websocketHelpers.invalidateFromWebSocket(entityInvalidations[entity]())`; UI components subscribe to **query state, not the socket** (`.claude/rules/ui.md:23-26`). Kit keeps the four generic entities.
- Widgets: `WebSocketStatus.tsx` (dot: connected/reconnecting/offline, flashes on event), `ConnectionBanner.tsx:9-29` (`role="status"` banner when not connected — Mirevue mounts it only in live-session views; the kit can mount it in `Layout` or leave it opt-in), `NotificationsBell.tsx:11-64` (`<details>` dropdown over `useNotifications()` = `notificationsQueryOptions` + dismiss/dismiss-all mutations). GM's `NotificationBell` aggregates surveys + invitations (app-specific).
- Mirevue's `PendingInvitationsBanner.tsx` (renders pending invites for the signed-in email with an Accept link) is generic and belongs on the kit's Home.

**Verdict:** Base Mirevue for all of it.

---

## 12. UI testing

- Mirevue `vitest.config.ts:161-171`: a `ui` project — `environment: 'jsdom'`, `plugins: [react()]`, `setupFiles: ['./tests/ui/setup.ts']`, `include: ['tests/ui/**/*.{test,spec}.{ts,tsx}']`, aliases `@` → `src`. `tests/ui/setup.ts:1-23`: `@testing-library/jest-dom/vitest`, `cleanup()` + `localStorage.clear()` after each, and a filter for React Router's per-`MemoryRouter` v7 future-flag warning. Deps: `jsdom`, `@testing-library/{react,jest-dom,user-event}`.
- Test idiom (`tests/ui/login.test.tsx:9-41`, `pending-page.test.tsx:18-44`, `sidenav.test.tsx:33-74`): fresh `QueryClient({ retry: false })` + `AuthProvider` + `MemoryRouter` wrapper; `vi.stubGlobal('fetch', vi.fn(url => new Response(JSON.stringify(...))))` keyed on URL substring; `vi.unstubAllGlobals()` after. No MSW (`.claude/rules/testing.md:43-46`). Primitive tests need no providers (`toast`, `theme-toggle`, `wizard`, `stepper`, `column-shell`, `inspector-outlet`).
- `tests/ui/contrast.test.ts:23-60` parses `index.css` tokens and asserts every pair in `scripts/lib/contrast-spec.ts` clears its WCAG floor — the design system's CI gate.
- GM: single `node` environment, no jsdom/testing-library in `package.json`; `tests/ui/` holds three pure-function tests, and `date-range-filter.test.ts:11-21` explicitly notes the absence of a DOM test setup.

**Verdict:** Base Mirevue wholesale. Ship the `ui` project, `setup.ts`, a `tests/ui/helpers/renderWithProviders.tsx` (extract the wrapper the three provider tests copy-paste), and seed tests: `toast`, `theme-toggle`, `login`, `protected-route`/`pending-page`, `sidenav`, `column-shell`, `wizard`, `websocket-backoff`, `contrast` (if the palette pipeline ships).

---

## 13. Convention docs and UX.md

- Mirevue `src/ui/CLAUDE.md` (23 lines) — layout map + five conventions (query keys from the factory, shared schemas for forms, `<details>` dropdowns, no CASL, tests location). `.claude/rules/ui.md` (53 lines, `globs: src/ui/**`) — theming, data layer, realtime, auth, and the columnar-workspace rule. Both accurate to the code. **Port both**, deleting the "No CASL" line and the workshop/dnd-kit paragraphs.
- GM `src/ui/CLAUDE.md` (391 lines) is **stale**: documents a terminal theme (`--terminal-green`, `.btn-terminal`, `:96-131`) that no longer exists, claims "Real-time Updates: Polling-based (WebSockets future)" (`:384`) while the websocket store is 723 lines, lists "Error Boundaries" (`:373`) that do not exist, and mandates CSS sync with `apps/desktop` (`:34-48`). `.claude/rules/server/ui.md` shows a ky-style client the code never had (`:45-61`); `hooks/CLAUDE.md` lists hooks that do not exist (`useUser`, `useSessions`, `useAnalytics`). Only `components/permissions/CLAUDE.md` is accurate — port it with CASL. Lesson for the kit: keep UI docs short enough to stay true.
- **UX.md** (25KB) — split:
  - *Generic design-system guidance (port, lightly de-branded):* §1 Principles; §2 Colour (token table, "structure from surface+border not shadow", one reserved accent, semantic colours only as tags, muted-text floor, the palette/Huetone pipeline); §3 Typography (roles/sizes table, mono as garnish); §4 Spacing (4px scale, panels vs cards, widths, shell description minus the workshop-context sidebar paragraph); §5 Borders/radii/shadows; §6 Buttons, Inputs, Left-nav item, Status tags, Tables/`.data-table`, Entity workspace (`ColumnShell`/`Rail`/`InspectorPanel`), Edit-in-slide-panel, Multi-step forms (`Wizard`/`Stepper`), Empty states, Progress, Errors; §8 Implementation (token-first, `@layer components` only for cross-cutting primitives, data-attribute variants, density, motion, a11y) and the Contrast-floors table; the Anti-patterns list.
  - *App-specific (strip):* the "who this is for"/"what the product is" preamble; `ATTENDEE_COLORS`/`TYPE_COLORS`; the workshop-as-context sidebar and breadcrumb (§4); Top-bar search; the status vocabulary `draft · scheduled · in-progress …`; "Documents/files are one component" (`DocumentList`/`DocumentPreview`); "A context's home is one lifecycle-adaptive page" and "Context vs entity" (§6); §7 Deferred.

---

## 14. Accessibility, dark mode, responsive

- Mirevue bakes a11y into the base layer: one `:focus-visible` ring (`index.css:277-281`), `prefers-reduced-motion` (`:304-311`), `--border-control` at 3:1 for inputs (`:352-360`), `aria-label` on every icon-only control (233 `aria-` attributes vs 22 in GM), `role="status"` banner, `role="tablist"/"tab"` filter tabs (`admin/UserList.tsx:32-44`), Escape-to-close on the inspector, `<details>/<summary>` dropdowns (keyboard-native). The contrast test enforces WCAG AA per token pair. Gaps: `ConfirmModal`/`AlertModal` are `div.modal` with no focus trap or `aria-modal`; both `biome.json:30-36` disable `noSvgWithoutTitle`, `useSemanticElements`, `useKeyWithClickEvents`.
- Dark mode: both first-class in Mirevue (`prefersdark`, same hue rows from opposite ends, dark status tints below the panel — UX.md §2); GM's dark theme is a hand-picked palette with no OS-preference default.
- Responsive: Mirevue drawer opens at `lg` (`Layout.tsx:135`), GM at `md` (`AdminLayout.tsx:114`); `Rail` pills below `lg`; `InspectorPanel` is in-flow ≥lg, slide-over md–lg, full-screen <md; `[data-density]` for compact tables. GM adds swipe gestures (`URLTabs`, `useSwipe`) and `mobile/*` helpers.

**Verdict:** Mirevue's conventions. Add a `<dialog>`-based `Modal` primitive (focus trap for free) and an `ErrorBoundary` — neither repo has one.

---

## (a) Proposed `src/ui/` file list for the kit

```
src/ui/
  index.html                      # theme pre-hydration (validated), favicons, single <title>
  main.tsx                        # @fontsource imports, index.css, StrictMode
  App.tsx                         # providers + route table (Layout mounted once for /*)
  index.css                       # Mirevue tokens/themes/base/primitives, app tail stripped
  CLAUDE.md                       # ported from Mirevue (≤30 lines)
  components/
    ErrorBoundary.tsx             # NEW — neither repo has one
    Layout.tsx                    # drawer shell, header slots, OrgSwitcher, user menu
    SideNav.tsx                   # config-driven, adminOnly/globalAdminOnly/ability flags, version footer
    OrgSwitcher.tsx               # extracted from Layout.tsx
    EnvironmentBadge.tsx          # GM BrandName + utils/environment (configurable hosts)
    ThemeToggle.tsx
    ProtectedRoute.tsx  AdminRoute.tsx  GlobalAdminRoute.tsx  RequireAbility.tsx
    ScrollToTop.tsx  LoadingIndicator.tsx  URLTabs.tsx
    NotificationsBell.tsx  WebSocketStatus.tsx  ConnectionBanner.tsx  PendingInvitationsBanner.tsx
    WebSocketProvider.tsx
    permissions/  AbilityContext.tsx  IfCan.tsx  index.ts  CLAUDE.md
    icons/ProviderIcons.tsx
    shared/  index.ts  Toast.tsx  EmptyState.tsx  Modal.tsx(<dialog>)  ConfirmModal.tsx  AlertModal.tsx
             SearchInput.tsx  PaginationControls.tsx  ColumnShell.tsx  Rail.tsx
             InspectorPanel.tsx  InspectorOutlet.tsx  Wizard.tsx  Stepper.tsx
             SectionPanel.tsx(+Skeleton, from GM AdminPanel)  SettingRow.tsx(Toggle/Input)
             PageHeader.tsx  LogoMark.tsx  Markdown.tsx  FieldError.tsx
  hooks/
    useAuth.tsx  usePermissions.ts  useNotifications.ts  useDebounce.ts  useModalState.ts
    useLocalStoragePreference.ts  useStagingTitle.ts(→useEnvironmentTitle)
  lib/
    api-client.ts  queryClient.ts  query-options.ts  websocketClient.ts  environment.ts  route-preload.ts?
  stores/
    websocketStore.ts  environmentMarker.ts          # toast store stays inside shared/Toast.tsx
  pages/
    Home.tsx  Login.tsx  MagicLinkVerify.tsx  InviteAccept.tsx  SelectTenant.tsx  Pending.tsx  NotFound.tsx
    Profile.tsx
    settings/  SettingsLayout.tsx  General.tsx  People.tsx  ApiKeys.tsx  Permissions.tsx?
    admin/     AdminLayout.tsx  AccessRequests.tsx  TenantList.tsx  TenantDetail.tsx  UserList.tsx  UserDetail.tsx
  public/  favicon set, logo.svg, README.md
tests/ui/  setup.ts  helpers/renderWithProviders.tsx  + seed tests listed in §12
```

## (b) Recommended provider stack order

```tsx
<ErrorBoundary>                                   // NEW; renders a token-styled fallback
  <QueryClientProvider client={queryClient}>      // module-level client, initializeQueryClient()
    <AuthProvider>                                // GET /auth/session (zod), tenant selection
      <AbilityProvider>                           // createMongoAbility(session.permissions)
        <WebSocketProvider>                       // needs authenticated + currentTenantId
          <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <ScrollToTop />
            <AppRoutes />                         // Suspense + Layout mounted once for /*
            <ToastContainer />
          </BrowserRouter>
        </WebSocketProvider>
      </AbilityProvider>
    </AuthProvider>
    {import.meta.env.DEV && <Suspense><ReactQueryDevtools/></Suspense>}
  </QueryClientProvider>
</ErrorBoundary>
```

No `HelmetProvider` (only needed for public SEO pages). `useEnvironmentTitle()` mounts inside `Layout`.

## (c) Shared components to ship

Toast (+`showToast`), EmptyState/EmptyStateCard, Modal (`<dialog>`), ConfirmModal, AlertModal, LoadingIndicator, SearchInput, PaginationControls, URLTabs, ColumnShell + Rail, InspectorPanel + InspectorOutlet, Wizard + Stepper, SectionPanel + SectionPanelSkeleton, SettingRow (toggle/input variants), PageHeader (restyled), FieldError, LogoMark, Markdown (optional), NotificationsBell, WebSocketStatus, ConnectionBanner, PendingInvitationsBanner, ThemeToggle, EnvironmentBadge, IfCan/IfCannot, ErrorBoundary. Hooks: useModalState/useModalWithData, useDebounce, useLocalStoragePreference family, useFileDropTarget (optional).

## (d) Open questions / risks

1. **Role guards vs CASL guards.** Mirevue routes on `tenantUser.role`; GM routes on abilities but also on role in `AdminRoute`. Decide: coarse `AdminRoute`/`GlobalAdminRoute` by role + `RequireAbility` per page, or abilities everywhere. Whichever wins, `SideNav` item flags must use the same mechanism.
2. **Invitation-only vs self-serve sign-up.** `/pending`, `accessRequest` in the session, and `/admin/requests` only make sense for invitation-only (Mirevue). GM's owner onboarding wizard only makes sense for self-serve. The kit should pick a default and leave the other as a documented extension.
3. **Global 401 handling.** Neither repo does it. Options: `QueryCache.onError` → `queryClient.clear()` + redirect to `/login?returnUrl=`; or have `api-client` throw a distinguishable `SessionExpired` that `ProtectedRoute` observes. Needs the 01-auth decision on session lifetime.
4. **No ErrorBoundary** in either repo (GM docs claim one). Add at the root and per-Layout `<main>`.
5. **Pagination meta shape** — `page/pageSize/totalPages` (Mirevue) vs `limit/offset/hasMore` (GM); must match the `src/shared` list schemas chosen in 04-api-shell.
6. **Palette/contrast pipeline depth.** `index.css` tokens are derived from `design/palette.json` via `scripts/build-palette.ts` + `scripts/lib/roles.ts` and gated by `tests/ui/contrast.test.ts` (`scripts/lib/contrast-spec.ts`, `contrast.ts`, `pnpm contrast:report`). Ship the whole pipeline (best long-term, ~5 extra files + a Huetone workflow) or ship only the emitted tokens + the contrast test?
7. **Theme naming and brand tokens** — `exec-light/dark`, aubergine/paper/ink hue names and `LogoMark` geometry are Mirevue brand; rename once in the kit and document the find/replace points (`index.html`, `ThemeToggle`, `contrast-spec`, tests).
8. **Personal vs tenant API keys** — GM supports both via `?userOnly=`; Mirevue only tenant keys. One `ApiKeysPanel({ scope })` if the API supports both.
9. **Dev quick-login** (`Login.tsx:14-20`, `/auth/dev-login`) is very useful but the account list is app-specific; make it come from a dev-only `/auth/dev-accounts` or a `VITE_DEV_ACCOUNTS` string.
10. **Layout mount strategy** — Mirevue re-mounts `Layout` per route element (simple, but header widgets remount on navigation); GM mounts it once under `/*` with nested `<Routes>`. Recommend GM's shape with Mirevue's guard components; verify `WebSocketStatus`/`NotificationsBell` do not flicker.
11. **Route preloading** — only worth shipping if the preload map is derived from one route definition; otherwise it will drift as GM's has.
12. **`@source` discipline** — if the kit ever imports a component library that ships JSX (as GM does with drizzle-cube), it must `@source` that package's dist, not safelist; document this so the 12KB safelist does not return.
