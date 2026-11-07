---
version: unreleased
previous: 0.25.0
date: null
breaking: false
migrations:
  - "tenants.external_org_id (text, unique, nullable)"
  - "tenants.idp_synced_at (timestamptz, nullable)"
  - "tenant_users.source (text manual|idp, NOT NULL default manual)"
  - "tenant_users.idp_synced_at (timestamptz, nullable)"
  - "users.global_admin_source (text manual|idp, nullable)"
  - "user_sessions.max_expires_at (timestamptz, nullable)"
areas: [api, db, config, shared, ui, docs]
touches_surfaces: []
requires_surfaces: []
manual: true
---

## What changed

IdP-managed tenancy (`OIDC_MANAGED_TENANCY`): the OIDC issuer's id_token and signed identity events now decide a person's tenants, roles and global admin, every session is capped, and Amazon Cognito logout and access denial work.

- `config.ts`: `OIDC_MANAGED_TENANCY`, `OIDC_ORGS_CLAIM` (default `orgs`), `OIDC_ROLE_MAP`, `OIDC_ADMIT_CLAIM`, `OIDC_GLOBAL_ADMIN_CLAIM`, `OIDC_SESSION_MAX_AGE_DAYS` (default 7, at most 30), secret `IDENTITY_WEBHOOK_SECRET`; needs an issuer and `TENANCY_MODE=multi`; `isIdpManaged(cfg)`.
- `packages/shared/src/idp.ts`: the orgs-claim schema and the identity-event schemas.
- `services/idp-tenancy.ts`: `readIdpClaims`, `idpClaimsAdmit`, `reconcileIdpClaims`, `applyIdentityEvent` (stale writes skipped by `idp_synced_at`).
- `auth/standard-webhooks.ts` + `routes/identity-events.ts`: `POST /api/identity/events`, mounted without `authMiddleware`, authenticated by its Standard Webhooks signature.
- `routes/auth/oauth.ts`: under managed tenancy the claims admit a person (not `SIGNUP_MODE`) and the reconcile runs before `completeLogin`; a Cognito pre-token denial → `/login?error=no_access`.
- `services/members.ts`: changing or removing a `source='idp'` membership → 409 `idp_managed`; the list returns `source`.
- `auth/sessions.ts`: `max_expires_at`, which the 30-day slide never passes; under managed tenancy every sign-in sets it.
- `auth/providers/oidc.ts`: `idTokenClaims` on the profile; `oidcEndSessionUrl` adds Cognito's `logout_uri`.
- Admin: `PUT /api/admin/tenants/:id/external-org` links a tenant to an issuer org (409 `external_org_taken`); `DELETE /api/admin/tenants/:id` deletes an organisation (a managed tenant has no owner — `docs/CONCEPTS.md` §1).
- UI: `no_access` copy on `Login.tsx`; a "Managed" badge and no controls on `idp` rows in `People.tsx`; the Identity provider org panel and a danger zone in `admin/TenantDetail.tsx`.

## How to apply

1. Add six columns to the Drizzle schema in `apps/web/src/db/schema/`: `tenants.externalOrgId`
   (`text('external_org_id').unique()`) and `tenants.idpSyncedAt`; `tenantUsers.source`
   (`text('source', { enum: MEMBERSHIP_SOURCES }).notNull().default('manual')`, exporting
   `MEMBERSHIP_SOURCES = ['manual', 'idp']`) and `tenantUsers.idpSyncedAt`;
   `users.globalAdminSource` (enum `GLOBAL_ADMIN_SOURCES = ['manual', 'idp']`, nullable);
   `userSessions.maxExpiresAt`. Every timestamp is `{ withTimezone: true }`. Run
   `pnpm db:generate` and read the SQL: six `ADD COLUMN`s and one `UNIQUE`. Never copy the kit's
   migration file.
2. Copy `packages/shared/src/idp.ts` from the kit. In `packages/shared/src/tenants.ts` add
   `membershipSourceSchema` and `source: membershipSourceSchema.default('manual')` on `memberSchema`.
   In `packages/shared/src/errors.ts` add `idpManaged: 'idp_managed'` and
   `externalOrgTaken: 'external_org_taken'`. In `packages/shared/src/admin.ts` add `externalOrgId`
   to `adminTenantListItemSchema`, `idpManaged` to `adminTenantDetailSchema`, and
   `setTenantExternalOrgRequestSchema`.
3. In `apps/web/src/config.ts` add the six `OIDC_*` keys after `OIDC_TRUST_EMAIL`, the secret
   `IDENTITY_WEBHOOK_SECRET`, the two `superRefine` checks (issuer + client id; not
   `TENANCY_MODE=single`) and `isIdpManaged`. Add the keys to `apps/web/.dev.vars.example` and the
   commented OIDC block of BOTH `apps/web/wrangler.toml` and `apps/web/wrangler.staging.toml`, then
   run `pnpm typecheck` and commit `worker-configuration.d.ts`.
4. In `apps/web/src/api/auth/cookies.ts` add `IDP_SESSION_MAX_AGE_DEFAULT_DAYS = 7`. In
   `apps/web/src/api/auth/sessions.ts` store `CreateSessionInput.maxAgeMs` as `maxExpiresAt`, have
   `touchSession` set `least(<now + 30 days>, coalesce(max_expires_at, 'infinity'))`, and select
   `u.global_admin_source` in `resolveSession`.
5. In `apps/web/src/api/routes/auth/helpers.ts` add `'no_access'` to `LoginErrorCode` and pass
   `maxAgeMs` from `OIDC_SESSION_MAX_AGE_DAYS` to `createSession` in `completeLogin` when
   `isIdpManaged(cfg)`.
6. In `apps/web/src/api/auth/providers/types.ts` add `idTokenClaims?: Record<string, unknown>` to
   `OAuthProfile`. In `apps/web/src/api/auth/providers/oidc.ts` return `idTokenClaims: claims` from
   `oidcProfile`, add `isAccessDeniedAtTokenExchange`, and set `logout_uri` beside
   `post_logout_redirect_uri` in `oidcEndSessionUrl`.
7. In `apps/web/src/api/utils/db/tenant-helpers.ts` give `CreateTenantForUserInput` optional
   `source`, `externalOrgId` and `idpSyncedAt`, written to the founding rows.
8. Copy `apps/web/src/api/services/idp-tenancy.ts`, `apps/web/src/api/auth/standard-webhooks.ts`
   and `apps/web/src/api/routes/identity-events.ts` from the kit, and mount
   `app.route('/api/identity', identityEventsRouter)` beside `/auth` in `apps/web/src/api/index.ts`.
9. In `apps/web/src/api/services/auth.ts` add `admittedBy?: 'idp'` to `AdmitInput`; in
   `admitUser`, after the bootstrap branch, create the user and return when it is set.
10. In `apps/web/src/api/routes/auth/oauth.ts` redirect `no_access` when
    `isAccessDeniedAtTokenExchange(err)` at the token exchange; when `def.id === 'oidc'` and
    `isIdpManaged(cfg)`, read the claims with `readIdpClaims`, pass `admittedBy: 'idp'` to
    `admitUser` when `idpClaimsAdmit(claims)`, and run `reconcileIdpClaims` after
    `upsertProviderLink` (on failure redirect `oauth_failed`).
11. In `apps/web/src/api/services/members.ts` select `source` in `listMembers` and throw
    `ConflictError(..., ERROR_CODES.idpManaged)` for an `idp` target in `changeMemberRole` and
    `removeMember`, right after the `support` check.
12. In `apps/web/src/api/services/admin.ts` make `setGlobalAdmin` write
    `globalAdminSource: isGlobalAdmin ? 'manual' : null`, and copy `setTenantExternalOrg`. In
    `apps/web/src/api/routes/admin.ts` add `PUT /tenants/:id/external-org` and
    `DELETE /tenants/:id` (slug confirmation, `operationLock(c.env.RATE_LIMIT_KV, …)`,
    `deleteTenant(db, id, c.env.JOBS_QUEUE, realtime)`).
13. In the UI add `no_access` to `LOGIN_ERROR_COPY` in `pages/Login.tsx`; lock the role and hide
    Remove for `m.source === 'idp'` in `pages/settings/People.tsx`; copy `useSetTenantExternalOrg`
    and `useAdminDeleteTenant` into `hooks/useAdminTenants.ts` and the two panels into
    `pages/admin/TenantDetail.tsx`.
14. Port the tests: the `OIDC_MANAGED_TENANCY` block of `tests/api/auth-oidc.test.ts`, the new
    cases in `tests/config/env-schema.test.ts` and `tests/api/admin.test.ts`, and
    `externalOrgId: null` on admin tenant fixtures in `tests/ui/`.
15. Port the docs: `docs/CONCEPTS.md` §1 and §2, `SETUP.md` 2.3c, the config line in `CLAUDE.md`
    and the `identity-events.ts` line in `apps/web/src/api/routes/CLAUDE.md`.

## Conflicts to expect

- `apps/web/src/api/auth/providers/oidc.ts` → `logout_uri` already added by hand → keep one `searchParams.set('logout_uri', …)`.
- `apps/web/src/api/services/members.ts` → an app that rewrote the owner guard → insert the `idp_managed` check after the target row is read, before any owner check.
- `apps/web/src/api/auth/sessions.ts` → an app that changed the `resolveSession` SQL → keep the app's joins, add `u.global_admin_source` to the select list only.
- `apps/web/src/api/utils/db/tenant-helpers.ts` → an app with extra tenant columns → keep them, add the three new fields beside them.

## Verify

1. `pnpm gate` is green.
2. `pnpm db:migrate` on a dev database adds the six columns above.
3. With `OIDC_MANAGED_TENANCY=true` and no `OIDC_ISSUER`, the Worker refuses to boot naming `OIDC_MANAGED_TENANCY`.
4. `POST /auth/logout` with an issuer advertising `end_session_endpoint` returns an `endSessionUrl` carrying both `post_logout_redirect_uri` and `logout_uri`.
5. A managed sign-in for a person with one org lands in that org's tenant, `PATCH /api/members/<their id>` answers 409 `idp_managed`, and their `user_sessions` row has `max_expires_at` seven days out.
6. With `IDENTITY_WEBHOOK_SECRET` set, an unsigned `POST /api/identity/events` answers 401, and a signed `membership.removed` for that person and org answers 204 and removes the membership.
7. `DELETE /api/admin/tenants/<id>` with the tenant's slug answers 204.
