# 02 — Tenancy + Policy/Role Permission Framework (CASL)

Analysis of the tenancy and permissions subsystem across **Mirevue** (`~/work/mirevue`, Node/Docker,
structural reference) and **GuideMode server** (`~/work/guidemode/apps/server`, Cloudflare Workers,
substrate reference), with a recommendation for the Workers-first starter kit.

Paths are abbreviated: `M:` = `~/work/mirevue/`, `G:` = `~/work/guidemode/apps/server/`,
`GT:` = `~/work/guidemode/packages/types/src/`.

---

## 0. Headline conclusions

1. **The two permission frameworks are the same code, one generation apart.** Mirevue's
   `src/permissions/abilities.ts` is a direct descendant of GM's — same `AbilityBuilder` /
   `createMongoAbility`, same `rolePermissions` map keyed by role, same `getEffectiveRole`, same
   `createAbilityFromSession`, same `guardPermission(c, action, subject)` middleware (`G:src/api/middleware/permissions.ts:19`
   and `M:src/api/middleware/permissions.ts:19` are byte-identical in intent). The kit is not
   choosing between two designs; it is choosing which *accretions* to keep.
2. **Neither repo uses CASL conditions or `accessibleBy`.** Verified by grep: zero hits for
   `accessibleBy`, `conditions:` on a CASL rule, or `@casl/ability/extra` in either `src/`. Abilities
   are pure `action × subject` strings per role. Tenant scoping is the `eq(x.tenantId, tenantId)`
   predicate in every query (both) plus Postgres RLS underneath (Mirevue only). Row-ownership
   ("my interview", "sessions I attend") is **route-scoped**, not policy-scoped
   (`M:src/permissions/abilities.ts:120-131` comments say exactly this). GM's "rich policy based
   role framework" is rich in **subjects** (18 vs 10), in a **subscription overlay** (`access`
   action on feature subjects), and in **UI integration** (`@casl/react`) — not in policy
   expressiveness.
3. **Base the server side on Mirevue, the UI ability layer on GM.** Mirevue has the stricter
   schema (RLS policies, `tenant_status`, `access_requests`, non-assignable role split), the only
   tenant-free auth path that is actually safe (`globalAdminMiddleware`), transactional invite
   acceptance, and typed `AppAbility`. GM has the only real client-side ability layer
   (`AbilityProvider` + `Can` + `IfCan` + `usePermissions`); Mirevue serialises `ability.rules`
   into `/auth/session` and then *ignores them*, gating the UI on raw `role` strings.
4. **Sign-up gating is a policy fork, not a merge.** GM auto-provisions a personal tenant on first
   login (first-user-becomes-owner, in every OAuth callback). Mirevue is invitation-only with
   admin-approved access requests and never auto-creates a tenant. **Neither implements domain
   rules or allow-lists** (verified: only hits are an avatar-URL domain check and a comment). The
   kit should ship this as a `SIGNUP_MODE` switch with Mirevue's machinery behind the gated mode.
5. **CF-compat risk is concentrated in one place: Mirevue's RLS connection pinning.**
   `withTenantScope` pins a `pg` connection and stamps a session GUC via `AsyncLocalStorage`.
   Hyperdrive pools connections, so per-connection `SET` is unsafe; the portable form is
   `SET LOCAL` inside a transaction, which GM's `neon-http` driver cannot do at all. Everything
   else in this subsystem is plain Hono + Drizzle and ports as-is.

---

## 1. Schema: tenant / membership / role / invitation

### 1.1 What each repo has

| Table | Mirevue | GuideMode | Notes |
|---|---|---|---|
| `tenants` | `M:src/db/schema/tenants.ts` — `id, name, slug(unique), status(active/suspended), createdAt, updatedAt, lastAccessedAt`; RLS policy keyed on own `id` (`:21`) | `G:src/db/schema/tenants.ts` — same core + `onboardingCompletedAt/DismissedAt/Goals`, `seedDataCreated` (`:15`), `isOssCorpus` (`:35`) | Mirevue adds `status` for suspension; GM adds onboarding + demo lifecycle flags |
| `users` | `M:src/db/schema/users.ts` — `id, username, email(unique), name, avatarUrl, isGlobalAdmin(:15), isBlocked(:16), lastLoginAt`; RLS by **membership** (`:26`) | `G:src/db/schema/users.ts` — same + `githubId(:19)`, `jiraAccountId`, `linearUserId`, `emailIsPlaceholder(:28)`, `firstSessionUploadedAt` | GM columns are all integration-specific |
| `user_sessions` | `id, userId, selectedTenantId(:36), expiresAt` | same + `isSurveyOnly(:49)` | `selectedTenantId` on the session row **is** the current-tenant mechanism in both |
| `tenant_users` | `M:src/db/schema/tenant-users.ts` — PK `(tenantId,userId)` (`:78`), `role` enum `owner/admin/member/support/directory` (`:26`), `joinedAt`, org-profile columns (`displayName, jobTitle, functionalArea, seniority, managerUserId`), `source` enum (`:41`); RLS (`:85`) | `G:src/db/schema/tenant-users.ts` — PK `(tenantId,userId)`, `role` enum `owner/admin/member/support` (`:7`), `joinedAt` | GM is the minimal generic form. Mirevue's profile columns + `directory` role + `source` are the People-directory feature |
| `team_invitations` | `M:src/db/schema/team-invitations.ts` — `id(uuid), tenantId, email, role` enum `owner/admin/member` (`:6`), `invitedBy, invitedAt, expiresAt, acceptedAt, status` enum `pending/accepted/expired` (`:5`); RLS (`:23`) | `G:src/db/schema/team-invitations.ts` — identical columns, no RLS | Identical. Note: **no unique index on `(tenantId, email, status)`** in either — duplicate-pending is prevented in application code only |
| `access_requests` | `M:src/db/schema/access-requests.ts` — `userId(unique :27), email, name, note, status pending/approved/rejected (:4), reviewedBy/At/Note` | — | Mirevue-only, the gated-signup queue |
| `tenant_settings` | `M:src/db/schema/tenant-settings.ts` — `notificationsEnabled, rewiredEnabled, timezone, updatedBy` | `G:src/db/schema/tenant-settings.ts` — `autoCleanup*, dataRetentionDays, notificationsEnabled, survey*, timezone, aivaRoleDisplayOverrides, updatedBy` | Both: one row per tenant, all columns app-specific except `timezone`/`notificationsEnabled` |
| `tenant_user_settings` | — | `G:src/db/schema/tenant-user-settings.ts` — `unique(tenantId,userId)`, `favorites jsonb` | Per-user-per-tenant prefs; generic shape, app-specific payload |
| `tenant_subscriptions` | — | GM billing (Paddle) | Strip |

**How a user belongs to multiple tenants:** `users` is global (unique on `email`), `tenant_users`
is the join with a composite PK, and `user_sessions.selectedTenantId` records the current one.
Both repos identical.

**Current-tenant selection / switching:**
- Resolution in `authMiddleware`: selected tenant if membership still valid, else oldest membership
  (`M:src/api/middleware/auth.ts:225-233`; GM does the same in one SQL `ORDER BY (tu.tenant_id =
  us.selected_tenant_id) DESC NULLS LAST, tu.joined_at ASC` inside a LATERAL join,
  `G:src/api/middleware/auth.ts:347-367`). A stale selection is cleared as a side effect.
- Switching: `POST /auth/select-tenant` verifies membership then updates the session row
  (`M:src/api/routes/auth/session-management.ts:175`; `G:.../session-management.ts:186`, GM
  hand-parses the body — Mirevue uses `zValidator`).
- UI: `useAuth().selectTenant` → hard `window.location.href = '/'` after success, with a
  `localStorage.selectedTenantId` fallback and an auto-select effect (`M:src/ui/hooks/useAuth.tsx`).
  `M:src/ui/pages/SelectTenant.tsx` is the switcher page.

### 1.2 Verdict

- **Base: Mirevue** for `tenants` (+`status`), `users`, `user_sessions`, `tenant_users`,
  `team_invitations`, `access_requests`, and the RLS helpers `tenantIsolation()` /
  `membershipIsolation()` (`M:src/db/schema/rls.ts:36,78`). Keep the modern drizzle
  `extraConfig` array form (Mirevue) over GM's object form.
- **Strip from Mirevue:** `tenant_users.displayName/jobTitle/functionalArea/seniority/managerUserId/source`
  and the `directory` role (People directory / org-chart feature — reintroduce as an optional
  module; the `setWhere: role='directory'` upsert pattern is worth keeping as a comment/template),
  `tenant_settings.rewiredEnabled`.
- **Strip from GM:** all `users.*Id` provider columns, `emailIsPlaceholder`, `firstSessionUploadedAt`,
  `user_sessions.isSurveyOnly`, `tenants.isOssCorpus`, `tenant_subscriptions`. **Keep** from GM:
  `tenants.seedDataCreated` + `lastAccessedAt` (demo-tenant lifecycle) and the
  `tenant_user_settings` shape (rename `favorites` → generic `preferences jsonb`).
- **Add:** a partial unique index `(tenant_id, lower(email)) WHERE status='pending'` on
  `team_invitations` — both repos rely on a read-then-insert check.
- **CF-compat:** schema is driver-neutral. RLS *policies* migrate fine (drizzle-kit `pgPolicy`); RLS
  *enforcement* depends on the connection strategy (see §4.3).

---

## 2. Gated sign-up

### 2.1 GuideMode: self-serve, first-user-becomes-owner
Every login path calls `handlePendingInvitation` first, then if `isNewUser` (OAuth) or
"has zero memberships" (magic link) calls `createTenantForUser(db, user, "<name>'s Team", username,
env, 'new_user')` — `G:src/api/routes/auth/oauth-github.ts:298-313`, `G:.../magic-link.ts:143-152`,
plus microsoft/notion/slack/gitlab/google/linear (8 call sites). `createTenantForUser`
(`G:src/api/utils/db/tenant-helpers.ts:43`) is untyped (`db: any`), non-transactional, and also
seeds dashboards + label mappings + emails ops. Users can also mint additional tenants from settings
(`G:src/api/routes/settings/tenant-settings.ts:245`) and owners can delete the tenant (`:306`, `:334`
explicit role check). No allow-list, no domain rule.

### 2.2 Mirevue: invitation-only + admin-approved access requests
- **Never auto-creates a tenant.** `createTenantForUser` (`M:src/api/utils/db/tenant-helpers.ts:32`)
  is transactional (`:60`) and has exactly one production caller: the admin approve endpoint
  (`M:src/api/routes/admin.ts:97-171`), which can also approve into an *existing* org with a role.
- Every login path runs `handleLoginPrologue` (`M:src/api/routes/auth/helpers.ts:58`) =
  `promoteDirectoryMemberships` then `handlePendingInvitation` (`:75`; cookie strategy + email
  strategy `:124`). Then, if the user has zero memberships, `ensureAccessRequest`
  (`M:src/api/utils/db/access-helpers.ts:120`) writes one idempotent `access_requests` row, emails
  every global admin (`:26`), and the client is sent to `/pending`
  (`M:src/api/routes/auth/magic-link.ts:158-173`, `M:.../dev-login.ts:77-81`).
- `authMiddleware` 403s tenant-less users with `code: 'pending_approval' | 'no_tenant'`
  (`M:src/api/middleware/auth.ts:239-248`) and suspended orgs with `code: 'tenant_suspended'`
  (`:104`, `:254`). `GET /auth/session` is deliberately *not* behind it and returns
  `accessRequest` so the UI can render `/pending` (`M:src/shared/auth.ts:60`;
  `M:src/ui/pages/Pending.tsx`; `M:src/ui/components/ProtectedRoute.tsx` redirects when
  `tenants.length === 0`).
- **First global admin bootstrap is manual SQL** (`M:SETUP.md:210-215`); `pnpm seed` does it for
  dev via `seedLocalAdmin` (`M:scripts/seed.ts:83`).

### 2.3 Verdict
- **Base: Mirevue** machinery (`access_requests`, `ensureAccessRequest`, `handleLoginPrologue`,
  `/pending`, admin approve/reject) — it is the *superset*: open mode is just "call
  `createTenantForUser` instead of `ensureAccessRequest` when memberships are empty".
- **Ship as config:** `SIGNUP_MODE = 'open' | 'invite_only' | 'approval'` and
  `SIGNUP_ALLOWED_DOMAINS` (comma-separated; **new code**, absent in both repos — enforce at the
  verify step, i.e. where `ensureAccessRequest` runs, never at magic-link *request* time, per
  Mirevue's spam reasoning in `docs/CONCEPTS.md:45-47`). Also `BOOTSTRAP_ADMIN_EMAILS` to
  replace the manual SQL step: on first login of a listed email set `isGlobalAdmin=true`.
- **Strip:** Mirevue's `promoteDirectoryMemberships` (goes with the directory module); GM's
  dashboards/mapping seeding + ops email inside `createTenantForUser` (make it a
  `onTenantCreated` hook).
- **CF-compat:** none of this touches Node APIs. GM's `getMagicLinkSecret(databaseUrl)` derives the
  HMAC key from `DATABASE_URL.slice(0,32)` (`G:src/api/auth/magic-link.ts:113`) — a security
  smell; use Mirevue's env-key version (`M:src/api/auth/magic-link.ts:14`, `OAUTH_ENCRYPTION_KEY`).

---

## 3. `src/permissions/` — abilities

### 3.1 Shape (identical skeleton)
```
Actions  = 'read' | 'manage' | 'access'
Subjects = 'all' | 'Tenant' | 'TenantMember' | 'ApiKey' | 'Invitation' | …app subjects
rolePermissions = { globalAdmin, owner, admin, support, member[, directory] }
getEffectiveRole(ctx) → isGlobalAdmin ? 'globalAdmin' : tenantUser.role
defineAbilitiesFor(ctx) → AbilityBuilder(createMongoAbility).build()
createAbilityFromSession(session) → defineAbilitiesFor(...)
```
`M:src/permissions/abilities.ts:140,165,191`; `G:src/permissions/abilities.ts` same names.

### 3.2 Differences
| Aspect | Mirevue | GuideMode |
|---|---|---|
| `AppAbility` type | `MongoAbility<[Actions, Subjects]>` — real type | `export type AppAbility = any` in the shared types package (`GT:permissions.ts:37`) — **typing hole**, every `c.get('ability')` is `any` |
| Subjects | 10: core 5 + `Notification`, `WorkshopSession`, `Interview`, `InterviewGraph`, `Domain` | 18: core 4 (`GitHubApp` in place of `Invitation`) + `Session, Analytics, Team, Repository, TeamTarget, Integration, Dashboard, WorkTracking, AIVA` + 4 feature subjects |
| Resource groups | `TENANT_RESOURCES`, `DATA_RESOURCES` | + `TEAM_RESOURCES`, `MANAGEMENT_RESOURCES`, `SUBSCRIBER_FEATURES` (`:23`) |
| `admin` role | `manage Tenant` **granted** (admin does tenant config); owner-only actions use explicit `role === 'owner'` checks (`M:src/api/routes/members.ts:301`) | `read Tenant` only; `guardPermission('manage','Tenant')` *is* the owner check (`G:.../team-members.ts:632`) |
| `support` | = admin grants (`:60` shared fn) | = owner grants (`:101`) |
| `directory` | present, grants nothing (`:134`) | — |
| Subscription overlay | — | `applySubscriptionPermissions` (`:120-170`): `can/cannot('access', SUBSCRIBER_FEATURES)` by Paddle tier/plan; global admin gets `access all` |
| Logging | pino `logger.warn` | `console.warn` |
| Docs | `M:src/permissions/CLAUDE.md` — accurate, 20 lines | `G:src/permissions/CLAUDE.md` — long, partially stale (says member is read-only; code grants `manage DATA_RESOURCES`) |

### 3.3 How the ability is built per request and exposed
- Server: `authMiddleware` builds `SessionContext` then `c.set('ability', createAbilityFromSession(ctx))`
  for both cookie and API-key auth (`M:src/api/middleware/auth.ts:63`; GM same). API-key auth
  loads the key owner's real membership role, so API keys inherit the user's CASL role.
- Client: `GET /auth/session` returns `permissions: ability.rules` (`M:.../session-management.ts:162`;
  `G:.../session-management.ts:172`) plus `tenantUser.role`, `currentTenantId`, `tenants[]`.
  - **GM consumes it:** `AbilityProvider` → `createMongoAbility(auth.permissions)`
    (`G:src/ui/contexts/AbilityContext.tsx:37-48`), `Can = createContextualCan(AbilityContext.Consumer)`
    (`:17`), `IfCan`/`IfCannot` (`G:src/ui/components/permissions/IfCan.tsx:8,26`), `usePermissions()`
    with `can/cannot/isOwnerLevel/isAdminLevel/isGlobalAdmin/getUserRoleLevel` and
    `useSubjectPermissions(subject)` (`G:src/ui/hooks/usePermissions.ts:9,76`).
  - **Mirevue does not:** `@casl/react` is in `package.json` but unused in `src/ui`; gating is
    `tenantUser?.role === 'owner' || 'admin' || 'support' || user.isGlobalAdmin`
    (`M:src/ui/components/AdminRoute.tsx:20-23`, `Layout.tsx:132`, `Home.tsx:39`,
    `SettingsLayout.tsx:103`) plus per-endpoint `permissions: { canManageMembers, canManageOwners }`
    computed server-side in list responses (`M:src/api/routes/members.ts:151-155`).
  - Both: `globalAdmin` also grants `manage TENANT_RESOURCES` explicitly because `'all'` "may not
    serialize correctly" (`M:abilities.ts:78-83`) — actually `manage all` serialises fine; the real
    reason to keep it is that `createMongoAbility` on the client handles `all` correctly too, so
    this fallback can be dropped.

### 3.4 Verdict
- **Base: Mirevue `abilities.ts`** (typed, pino, no billing). Import GM's `access`-action feature
  hook as an **extension point**: `applyFeatureFlags(can, cannot, ctx)` with an injected
  `ctx.features: string[]` resolved by the app (from a subscription table, KV flag, or env) — the
  *pattern* is the reusable part, the Paddle tier switch is not.
- **Remove** `directory` from the core role union; keep `support`.
- **Resolve the owner-vs-admin divergence explicitly.** Recommendation: follow **GM** semantics
  for the *CASL* layer — `admin` gets `read Tenant`, `manage TenantMember/Invitation/ApiKey`;
  `owner` gets `manage Tenant` — *and* keep Mirevue's rule that irreversible actions (delete
  tenant, transfer/change owner) are additionally guarded by an explicit `role === 'owner'` check
  (`M:src/api/routes/members.ts:296-302`). That way `manage Tenant` is unambiguous ("owner
  level") and tenant *settings* pages can opt in admins with a narrower `manage TenantSettings`
  subject if an app wants that.
- **Client:** adopt GM's `AbilityContext` + `Can` + `IfCan` + `usePermissions` verbatim (type
  them against the kit's `AppAbility`). Drop Mirevue's role-string gating in `AdminRoute` in favour
  of `<Can I="manage" a="TenantMember">`. Keep Mirevue's habit of returning `permissions: {...}`
  booleans on list endpoints for things CASL cannot express (`canManageOwners`).
- **CF-compat:** `@casl/ability` is pure JS; fine on Workers.

---

## 4. Route-level enforcement

### 4.1 Guards
- `guardPermission(c, action, subject): Response | null` — returns `401 {error:'Authentication required'}`
  if no ability, `403 {error:'Forbidden', message:'You do not have permission to <action> <subject>'}`
  otherwise (`M:src/api/middleware/permissions.ts:19-36`, GM identical). Used as
  `const denied = guardPermission(...); if (denied) return denied` at the top of handlers.
- `requirePermission(permission: string)` — **legacy** string-array check on `auth.permissions`
  (`['read','write','admin']`) that predates CASL (`M:auth.ts:302`, `G:auth.ts:524`). Still exported,
  barely used. **Drop from the kit**; keep `auth.permissions` only for API-key scopes if needed.
- `requireGlobalAdmin` (both) vs `globalAdminMiddleware` (Mirevue only, `M:auth.ts:327`): GM
  mounts `/api/glbladm/*` behind `authMiddleware` **then** `requireGlobalAdmin`
  (`G:src/api/index.ts:314-316`), which means a global admin with no tenant membership gets 403
  from `authMiddleware` before reaching admin routes — this only works because GM auto-provisions
  everyone a tenant. Mirevue's `globalAdminMiddleware` resolves session/API key, requires
  `isGlobalAdmin`, sets `tenantId: ''` and a `manage all` ability, and is "the ONLY tenant-free
  auth path" (`M:src/api/index.ts:88`). **Base: Mirevue.**
- Mirevue's `withAuthAndDb(c, handler)` (`M:src/api/utils/routes/route-helpers.ts`) is the
  mandated prologue: hands `{ tenantId, user, db, unscopedDb, scoped }` and refuses handlers that
  read `c.get('session')` by hand. `withEngagement(c, { subject, access, writable })`
  (`M:src/api/utils/routes/with-engagement.ts:163-171`) is a **declarative resource guard**: CASL
  subject + `'manage' | 'attendee' | 'member'` access level + lifecycle checks in one prologue,
  returning 404 (not 403) for non-attended resources so existence is not leaked. GM has
  `withAuthAndDb` too but nothing like `withEngagement`. Generalise this as `withResource`.

### 4.2 How conditions map to tenant-scoped queries
They don't — there are no CASL conditions. The mapping is:
1. `tenantId` comes from `session.tenantId` (resolved from the session row's membership, never
   from client input) and every query has `eq(table.tenantId, tenantId)`.
2. Row ownership is a *second* predicate in the route (attendee roster join, `userId = user.id`),
   chosen by the route based on `can(ability,'manage',Subject)` (`M:abilities.ts:120-131`).
3. Mirevue adds RLS underneath: `withTenantScope` pins a connection and sets
   `app.tenant_id`; policies `USING/WITH CHECK tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid`
   (`M:src/db/schema/rls.ts:17,36`). `users` is policied by membership sub-select (`:78`).
   `unscopedDb` is an allow-list of three cross-tenant reads enforced by a source-scanning test
   (`M:tests/api/unscoped-allowlist.test.ts:38-44`).
4. Cross-tenant admin work is confined to `routes/admin.ts` on the system pool.

If the kit later wants CASL conditions (`can('read','Thing',{ ownerId: user.id })`), the extension
is `@casl/ability/extra` `rulesToDrizzle`-style translation — neither repo has done it, so treat
as future work, not porting.

### 4.3 CF-compat (the one real problem)
- `withTenantScope` uses `node:async_hooks` `AsyncLocalStorage` + a `pg.Pool` with pinned
  clients (`M:src/db/tenant-scope.ts`). On Workers: `AsyncLocalStorage` works under `nodejs_compat`
  but **Hyperdrive multiplexes connections**, so a session-level `SET app.tenant_id` may not stick
  to the next statement. Portable form: wrap each request's DB work in a transaction and
  `SET LOCAL app.tenant_id = …` (transaction-scoped GUC), or `set_config(..., true)` inside the
  transaction. `SET LOCAL` requires a driver with transactions: `postgres-js` over Hyperdrive
  (GM uses this for non-Neon URLs, `G:src/db/client.ts:57`) yes; `neon-http` (GM uses this for
  Neon URLs, `:54`) **no transactions at all**. This is also why GM's invite-accept is bare
  sequential writes while Mirevue's is one `db.transaction` (`M:src/api/routes/invitations.ts:342`).
- Recommendation: kit uses **Hyperdrive → postgres-js (or `pg` with `nodejs_compat`)**, keeps
  Mirevue's policies + `TENANT_SCOPE_MODE=off|pin|enforce` config, and reimplements
  `withTenantScope` as a transaction wrapper with `SET LOCAL`. Ship with `off` default; the
  `tenantId` predicates carry isolation on day one (Mirevue's own stance: "RLS is defence in depth;
  the predicates stay").
- Mirevue's `broadcastData` on invite/member changes (pg `LISTEN/NOTIFY` broadcaster) → adapter
  seam for GM's `NOTIFICATIONS_HUB` Durable Object; out of scope for this module.
- GM's `fireAndForget(c, promise)` → `c.executionCtx.waitUntil` (`G:auth.ts:194-199`) for
  session-extend / `lastAccessedAt` touch is the correct Workers idiom; Mirevue awaits them inline.
  **Take GM's.** Also take GM's single LATERAL-join session query (`:347`) — 1 round trip vs
  Mirevue's 4-5, which matters when the Worker is cross-region from Postgres.

---

## 5. Tenant admin surface

### 5.1 Members / invite / role / remove
| Endpoint | Mirevue (`M:src/api/routes/members.ts`) | GM (`G:src/api/routes/settings/team-members.ts`) |
|---|---|---|
| `GET /` list (members + pending, paginated, search) | `:31`; returns `permissions:{canManageOwners (explicit owner), canManageMembers, canReadTenant}` | `:28`; `permissions:{canManageTenant, canManageMembers, canReadTenant}`; adds billing columns |
| `POST /invite` | `:159` — `guard manage TenantMember`; refuses `owner` role (`:168`); dedupe against members (excluding `NON_MEMBER_ROLES`) and pending invites; 7-day expiry; signed one-click `auth` token in URL; email; broadcast | `:373` — same logic, `role: z.enum(['admin','member'])` |
| `POST /invite/bulk` (≤200) | — | `:180` |
| `GET /invite-link/:email`, `POST /resend/:email` | — | `:511`, `:546` |
| `PATCH /:userId/role` | `:275` — owner-involving change → explicit `role==='owner'` else `manage TenantMember`; validated by shared `updateMemberRoleSchema` which omits `support/directory` | `:606` — owner-involving → `manage Tenant`; plus billing queue side-effects |
| `DELETE /:userIdentifier` (userId or email→revoke invite) | `:320`; cannot remove owner (`:379`); `removeTenantMembership` also clears roster rows (RLS invariant) | `:697`; same, plus billing |

Both mount under `authMiddleware` (`M:src/api/index.ts:124`; GM `settings.route('/team', …)`).

### 5.2 Tenant settings
- Mirevue `M:src/api/routes/tenant-settings.ts` — `GET/PATCH /`, `guard manage Tenant`, upsert one
  row, `updatedBy = user.email`. `M:src/api/routes/tenant-setup.ts` — read-only readiness aggregate
  ("members active/pending", AI configured) for a Home checklist; generic idea, app-specific
  payload.
- GM `G:src/api/routes/settings/tenant-settings.ts` — `GET/PATCH /` (`:30`, `:134`) + **`POST /tenant`**
  create additional org (`:245`, switches session) + **`DELETE /tenant`** with slug+name
  confirmation, explicit owner check (`:306-334`).

### 5.3 Global admin (`/admin`)
- Mirevue `M:src/api/routes/admin.ts` behind `globalAdminMiddleware`: access-request list/approve/reject
  (`:54,97,175`), tenants list/detail/patch(name,status) (`:215,243,286`), **enter/leave as
  `support`** by inserting a real `tenant_users` row (`:312,341`), users list/detail/block/global-admin
  flag with self-protection and "last admin must remain" (`:376-543`). UI:
  `M:src/ui/pages/admin/*` gated by `GlobalAdminRoute` (cosmetic; `:11-13` comment).
- GM `G:src/api/routes/glbladm.ts` behind `authMiddleware + requireGlobalAdmin`: tenants + stats,
  join as support (`:152-184`), leave (`:190`), delete tenant, subscriptions CRUD, users, issue
  magic-link/invite-link on behalf of a user (`:725,754`), block, delete user, reset dashboards.

### 5.4 Verdict
- **Base: Mirevue** for members/invite/role/remove (cleaner validation via shared zod contracts
  `M:src/shared/tenants.ts:5,18,22,60,65`; no billing tangle), for `/admin` (proper tenant-free
  middleware, access-request review, suspend, "last admin" guard), and for the `support`-as-membership
  model (both do it; Mirevue documents and counts it correctly with `NON_MEMBER_ROLES`).
- **Add from GM:** bulk invite, resend, copy-invite-link, `POST /tenant` (create additional org —
  gate behind `SIGNUP_MODE`/`ALLOW_SELF_SERVE_ORGS`), `DELETE /tenant` (owner, name confirmation),
  admin "send magic link to user".
- **Strip:** GM billing/seat hooks (`doesRoleChangeAffectBilling`, `BILLING_QUEUE`), Paddle
  subscription admin, dashboards/mappings reset; Mirevue `people.ts` directory routes, `tenant-setup`
  AI readiness fields, `rewiredEnabled`.
- **UI base:** Mirevue `M:src/ui/pages/settings/People.tsx` (members table with role select,
  invite modal, pending rows) and `M:src/ui/pages/admin/*` (TenantList/Detail, UserList/Detail,
  AccessRequests + ApproveRequestModal), re-gated with GM's `Can`/`IfCan`.

---

## 6. Invitation flow end-to-end

Identical design in both; Mirevue's is the hardened version.

1. **Create** — admin `POST /api/members/invite {email, role}` → `team_invitations` row (7 days) →
   email with `${APP_URL}/invite/accept?token=<invitationId>&auth=<HMAC(email, inviteId)>`
   (`M:members.ts:208-232`). The raw row UUID is the capability; the `auth` token additionally
   enables one-click join without a prior login.
2. **Landing** — public `GET /api/invite/details?token=` (`M:src/api/routes/invitations.ts:111`;
   validates UUID shape first) renders `M:src/ui/pages/InviteAccept.tsx`.
3. **Accept** — public `POST /api/invite/accept {token, auth?}` (`:148`):
   - with valid `auth` and matching email: upsert `users` by email, ensure `oauth_providers`
     `magic_link` row, upsert membership with `setWhere role='directory'` (never demotes an existing
     owner/admin, `:243-255`), mark invite accepted, email owners, create session with
     `selectedTenantId = invite.tenantId`, return `redirectUrl`.
   - with a session cookie: email must match (`400` with explanatory message otherwise); one
     transaction marks accepted + upserts membership + points session at the tenant (`:342-379`).
   - neither: set `pending_invitation` cookie (10 min) and return `{requiresAuth, loginUrl}`
     (`:410-421`).
4. **Login with pending invite** — `handlePendingInvitation` on every login path: cookie strategy,
   then email strategy for users with zero memberships (`M:src/api/routes/auth/helpers.ts:75,124`) →
   session + redirect to `/invite/accept?token=`.
5. **Already-member with other invites** — `GET /api/invitations/pending` (authenticated,
   `unscopedDb`, keyed on caller's own email, `:79`) feeds `M:src/ui/components/PendingInvitationsBanner.tsx`.
6. **Revoke** — `DELETE /api/members/<email>`.
7. Owners are emailed on acceptance (`notifyOwnersOfAcceptance`, only when a membership was
   actually created).

**Gaps in both:** no `expired` status transition job (status is checked against `expiresAt` at read
time); invitation `id` doubles as the bearer token in the URL (fine while ids are v4 UUIDs, but a
dedicated random `token` column would allow rotation/resend without a new row); `invitedBy` is a
`varchar` holding a user id (no FK).

**Verdict:** Base Mirevue; make the accept path transactional on the kit's driver (§4.3); add a
`token` column; add GM's resend/invite-link endpoints.

---

## 7. Demo / seed tenant patterns

- **Mirevue `pnpm seed`** (`M:scripts/seed.ts`): idempotent script — `DEMO_TENANT` acme (`:26`),
  three users owner/admin/member (`:28`), a pending invitation, sample notifications, an API key
  printed once, plus `seedLocalAdmin` (`:83`) which upserts `admin@local.com`, sets
  `isGlobalAdmin`, gives them their own org via `createTenantForUser`, and approves any access
  request they filed. Runs on the owner pool; `SEED_ON_START` flag in Docker.
- **GM**: no offline seed; instead a **runtime** `POST /api/seed-data` (`G:src/api/routes/seed-data.ts:79`)
  guarded by `manage TenantMember` and a KV `operationLock` (`:81`; `G:src/api/middleware/operation-guard.ts:17`)
  that generates realistic domain data into the *current* tenant, sets `tenants.seedDataCreated`,
  and a nightly cron `cleanupInactiveDemoTenants` (`G:src/api/services/demo-data-cleanup/index.ts:31`)
  wipes seed data from tenants with `seedDataCreated=true` and `lastAccessedAt > 30d`.
  Test fixtures use three named tenants (`G:tests/fixtures/data/tenants.json`).
- **Verdict:** ship **both** patterns, genericised: Mirevue's script as `pnpm seed` (tenant + 3
  roles + pending invite + local global admin + API key — this is exactly the generic core), and
  GM's `seedDataCreated`/`lastAccessedAt`/cleanup-cron trio as the "demo tenant lifecycle" hook
  (the data generator itself is app-specific; expose a `seedDemoData(db, tenantId)` seam). On
  Workers, `pnpm seed` runs as a Node script against the DB URL (as GM's `scripts/` do), not inside
  the Worker; the KV `operationLock` is a good generic per-tenant mutex to keep.

---

## 8. Material differences — which is cleaner and why

| Area | Cleaner | Why |
|---|---|---|
| Schema hygiene | Mirevue | RLS policies on every tenant table, `tenant_status`, `access_requests`, assignable-vs-readable role split enforced by two zod enums (`tenantRoleSchema` vs `membershipRoleSchema`) so no endpoint can mint `support` |
| Auth middleware | GM for *performance* (1 query + `waitUntil`), Mirevue for *correctness* (suspended-tenant check, pending-approval codes, tenant-free admin path) | Merge: Mirevue's semantics on GM's query shape |
| Abilities | Mirevue | Typed `AppAbility`; no Paddle branching; honest comments about route-scoping |
| Feature gating | GM (idea) | `access` action + feature subjects is a good generic overlay; the tier switch is not |
| UI permissions | GM | Only repo that actually uses the serialised rules; `Can`/`IfCan`/`usePermissions` are drop-in |
| Members/invites | Mirevue | Transactional accept, `setWhere` non-demoting upsert, `NON_MEMBER_ROLES` counting, shared zod contracts; GM adds useful extras (bulk/resend/link) |
| Global admin | Mirevue | `globalAdminMiddleware` is tenant-free by design; "last admin must remain"; suspend; access-request review. GM's is gated through tenant auth and mixes in billing |
| Tenant lifecycle | GM | Self-serve create/delete, `lastAccessedAt`, demo cleanup |
| Docs | Mirevue | `src/permissions/CLAUDE.md` matches code; GM's is stale in places |
| Tests | Mirevue | `tests/api/members.test.ts` is a de-facto permission matrix (17 cases across owner/admin/member); `rls*.test.ts`, `unscoped-allowlist.test.ts` enforce architecture. GM has `tests/api/middleware/permissions.test.ts` (guard-level only) |

**How much of GM's richness is generic?** Of GM's 18 subjects, 4 are core-generic (`Tenant`,
`TenantMember`, `ApiKey`, `all`), 1 is a generic idea worth keeping as a slot (feature subjects via
`access`), and 13 are GuideMode domain nouns. Of its role handlers, `support` and the
`globalAdmin` fallback are generic; the subscription overlay is Paddle-specific. The UI layer is
~100% generic. Net: **the framework is generic; the policy *content* is ~25% generic.**

---

## 9. Environment variables (names only)

Mirevue (`.env.example` / `src/config.ts`) relevant to this module: `APP_URL`, `DATABASE_URL`,
`APP_DATABASE_URL`, `TENANT_SCOPE_MODE`, `OAUTH_ENCRYPTION_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`,
`NODE_ENV`, plus OAuth client id/secret pairs (`SLACK_*`, `MICROSOFT_*`, `GOOGLE_*`).

GM (`.dev.vars` / `src/types/env.ts`) relevant: `APP_URL`, `DATABASE_URL`, `PREVIEW_DATABASE_URL`,
`OAUTH_ENCRYPTION_KEY`, `RESEND_API_KEY`, `NODE_ENV`, `RELEASE_VERSION`, OAuth pairs, and bindings
`HYPERDRIVE`, `RATE_LIMIT_KV`, `NOTIFICATIONS_HUB`, `ASSETS`, `BILLING_QUEUE` (strip),
`PADDLE_*` (strip).

Proposed kit additions: `SIGNUP_MODE`, `SIGNUP_ALLOWED_DOMAINS`, `BOOTSTRAP_ADMIN_EMAILS`,
`ALLOW_SELF_SERVE_ORGS`, `INVITE_TTL_DAYS`.

---

## 10. (a) Proposed file list — kit tenancy + permissions modules

```
src/db/schema/
  rls.ts                    # tenantIsolation(), membershipIsolation(), APP_ROLE   [M]
  tenants.ts                # + status, lastAccessedAt, seedDataCreated            [M + G flags]
  users.ts                  # users, user_sessions(selectedTenantId)               [M]
  tenant-users.ts           # PK(tenantId,userId), role enum owner/admin/member/support  [M minus profile cols]
  team-invitations.ts       # + token column, partial unique (tenant, lower(email)) pending  [M]
  access-requests.ts        # gated sign-up queue                                  [M]
  tenant-settings.ts        # timezone, notificationsEnabled, settings jsonb       [M shape]
  tenant-user-settings.ts   # unique(tenantId,userId), preferences jsonb           [G shape]
src/db/tenant-scope.ts      # withTenantScope as transaction + SET LOCAL (Hyperdrive-safe)  [M, rewritten]
src/shared/
  tenants.ts                # tenantRoleSchema / membershipRoleSchema / NON_MEMBER_ROLES / member+invitation contracts  [M]
  auth.ts                   # sessionResponseSchema incl. permissions: rules[], accessRequest  [M]
  access-requests.ts        # approve (new-org | join) / reject contracts          [M]
  permissions.ts            # Actions, Subjects (core 5 + app extension), AppAbility (typed)  [M types, G location idea]
src/permissions/
  abilities.ts              # rolePermissions{globalAdmin,owner,admin,support,member} + applyFeatureFlags hook  [M + G hook]
  index.ts
  CLAUDE.md
src/api/middleware/
  auth.ts                   # authMiddleware (GM single-query + waitUntil; Mirevue semantics: suspended, pending_approval/no_tenant codes), globalAdminMiddleware  [M+G]
  permissions.ts            # guardPermission, can, isAdminLevel/isOwnerLevel/isGlobalAdmin  [M]
  operation-guard.ts        # KV per-tenant mutex                                  [G]
src/api/utils/
  routes/route-helpers.ts   # withAuthAndDb → { tenantId, user, db, unscopedDb, scoped }  [M]
  routes/with-resource.ts   # generalised withEngagement: { subject, access:'manage'|'owner'|'member' }  [M, genericised]
  db/tenant-helpers.ts      # createTenantForUser (transactional, onTenantCreated hook)  [M]
  db/access-helpers.ts      # ensureAccessRequest, notifyGlobalAdmins, getAccessRequestForSession  [M]
src/api/routes/
  auth/helpers.ts           # handleLoginPrologue/handlePendingInvitation, validateReturnUrl, signup-mode + domain gate  [M + new]
  auth/session-management.ts# GET /session (rules), POST /select-tenant, /logout   [M]
  members.ts                # list/invite/bulk/resend/invite-link/role/remove      [M + G extras]
  invitations.ts            # GET /invitations/pending (unscoped), public /invite/details + /accept  [M]
  tenants.ts                # GET/PATCH settings, POST create-org, DELETE org (owner+confirm)  [M + G]
  admin.ts                  # access-requests, tenants (suspend, support enter/leave), users (block, global-admin)  [M]
src/ui/
  contexts/AbilityContext.tsx      # AbilityProvider, Can, useAbility            [G]
  components/permissions/IfCan.tsx # IfCan, IfCannot                              [G]
  hooks/usePermissions.ts          # can/cannot/isOwnerLevel/isAdminLevel/isGlobalAdmin  [G]
  hooks/useAuth.tsx                # session query, selectTenant, accessRequest   [M]
  components/{ProtectedRoute,AdminRoute,GlobalAdminRoute}.tsx  # re-gated on Can  [M]
  components/PendingInvitationsBanner.tsx                                         [M]
  pages/{Pending,SelectTenant,InviteAccept}.tsx                                   [M]
  pages/settings/{SettingsLayout,Members,TenantSettings}.tsx                      [M People.tsx → Members]
  pages/admin/{AdminLayout,AccessRequests,ApproveRequestModal,TenantList,TenantDetail,UserList,UserDetail}.tsx  [M]
scripts/seed.ts             # demo tenant + owner/admin/member + pending invite + local global admin + API key  [M]
tests/api/
  members.test.ts           # permission matrix                                    [M]
  invitations.test.ts, admin.test.ts, auth-session.test.ts, rls.test.ts, unscoped-allowlist.test.ts  [M]
```

## 10. (b) Minimal generic role set + ability matrix

Roles on `tenant_users.role`: `owner`, `admin`, `member` (assignable via `tenantRoleSchema`);
`support` (readable, minted only by `/admin`, excluded from counts). Platform flag:
`users.isGlobalAdmin` (not a tenant role).

| Subject \ Role | globalAdmin | owner | admin | support | member |
|---|---|---|---|---|---|
| `all` | manage | – | – | – | – |
| `Tenant` (settings, delete*, ownership*) | manage | manage | read | manage | read |
| `TenantMember` | manage | manage | manage | manage | read |
| `Invitation` | manage | manage | manage | manage | read |
| `ApiKey` | manage | manage | manage | manage | read (own keys route-scoped) |
| `Notification` (own) | manage | manage | manage | manage | manage |
| `Feature:<name>` via `access` | access all | by `ctx.features` | by `ctx.features` | access all | by `ctx.features` |

`*` Delete tenant and changing/assigning `owner` additionally require an explicit
`session.tenantUser.role === 'owner'` check (not CASL), per Mirevue. App subjects are added by
extending `Subjects` and granting in the role handlers; default posture for a new app subject:
owner/admin/support `manage`, member `read` with route-scoped ownership for writes.

## 10. (c) Open questions / risks

1. **RLS on Hyperdrive.** Whether to ship `enforce` mode depends on the driver: `postgres-js`/`pg`
   over Hyperdrive with `SET LOCAL` in a transaction works; `neon-http` cannot. Decide driver
   first; ship policies regardless.
2. **Transactions in invite-accept and tenant creation.** Same driver dependency. If `neon-http`
   is chosen, document the non-atomic window (invite `accepted` without membership) and add a
   reconciliation.
3. **`AsyncLocalStorage` on Workers** — works with `nodejs_compat`, but the re-entrancy detection
   in Mirevue's `tenant-scope.ts` is designed around long-lived pools and SSE bodies outliving
   handlers; on Workers `waitUntil` is the equivalent. Simplify rather than port.
4. **Owner-vs-admin `manage Tenant` semantics** — the two repos disagree; §3.4 recommends GM's
   CASL semantics + Mirevue's explicit owner checks. Needs a decision before routes are written.
5. **Domain/allow-list gating does not exist in either repo** — new code, small, but untested
   territory (where to enforce for OAuth providers whose email may be unverified).
6. **First global admin bootstrap** — Mirevue is manual SQL; proposed `BOOTSTRAP_ADMIN_EMAILS`
   needs care (only promote on a *verified* login; log loudly).
7. **Invitation token = row id in URL** — acceptable but worth a dedicated `token` column for
   rotation; the signed `auth` param already provides one-click join.
8. **`support` role visibility** — Mirevue shows it in the customer's member list by design
   (transparency). Confirm this is the desired kit default.
9. **Multi-tenant session vs per-tenant URL** — both repos put the current tenant in the session
   row (one tab = one tenant). A `/t/:slug/...` URL scheme would remove the hard-reload on
   switch but changes every route; out of scope unless the kit wants it from day one.
10. **Feature-flag source** for the `access` overlay — subscription table (GM), KV/Flagship, or
    env — undecided; the hook should take an injected `features: string[]` so this stays open.
