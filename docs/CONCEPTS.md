# CONCEPTS — what is built, and why

One section per subsystem: what it does, the invariant it protects, the decision behind it
(D-numbers), and its **Known gaps**. Check here before assuming a capability exists; update it when
you change one. **Keep it short** — a section states the rule and points at where the detail lives.
Conventions and mechanics belong in `.claude/rules/*.md` and the per-directory `CLAUDE.md` files;
setup in `SETUP.md`; Cloudflare topology in `docs/DEPLOY.md`; RLS in `docs/RLS.md`.

| § | Section | § | Section |
|---|---|---|---|
| 1 | [Tenancy](#1-tenancy) | 9 | [AI layer](#9-ai-layer) |
| 2 | [Auth](#2-auth) | 10 | [Deployment](#10-deployment) |
| 3 | [API shell](#3-api-shell) | 11 | [CLI](#11-cli) |
| 4 | [Database](#4-database) | 12 | [Shared package](#12-shared-package) |
| 5 | [Background work and realtime](#5-background-work-and-realtime) | 13 | [Upgrading a copy](#13-upgrading-a-copy) |
| 6 | [Email and storage](#6-email-and-storage) | 14 | [Definition of done](#14-definition-of-done-for-the-kit) |
| 7 | [UI shell](#7-ui-shell) | 15 | [Feature flags](#15-feature-flags) |
| 8 | [Analytics](#8-analytics) | 16 | [Plugins](#16-plugins) |
|  |  | 17 | [Connectors](#17-connectors) |
|  |  | 18 | [Security testing](#18-security-testing) |
|  |  | 19 | [MCP server](#19-mcp-server) |

**Layout (D26).** A pnpm workspace: `apps/web` (the Worker — Hono API + React UI, §§1–10),
`apps/cli` (§11), `packages/shared` (zod contracts, §12), and `apps/evals` (developer-run eval
suites on vitest 4, §9 — never part of the gate).

---

## 1. Tenancy

**Every row of domain data belongs to a tenant, and the schema is the same for one tenant or many.**

- **`TENANCY_MODE = multi | single` (D25)** is configuration, not a fork. `multi`: users join many
  tenants via `tenant_users`, the session carries the current one. `single`: one tenant, every
  admitted user auto-joins as `member`; multi-only surface is 404 `tenancy_mode_single`
  (`requireMultiTenant`) and hidden via `useTenancyMode()`. Switching to `multi` needs no migration.
  The auto-join (`onNoTenant`) runs for a NEW person `SIGNUP_MODE` admits, for dev login and for a
  `BOOTSTRAP_ADMIN_EMAILS` admin (who creates the tenant on an empty database); a returning person
  with no membership gets a tenant-less session instead. Enterprise identity in single mode: the
  one tenant IS the deployment, so the identity seam takes only its id (another is a tenant that
  does not exist), a plugin's `deprovision` BLOCKS the leaver (§16), `OIDC_MANAGED_TENANCY` refuses
  to load (it creates one tenant per issuer org), and the admin console's issuer-org link and
  organisation delete answer 404 `tenancy_mode_single`.
- **`SIGNUP_MODE = open | invite_only | approval` (D9)**, default `invite_only`. Uninvited logins
  land on `/pending`; `approval` also files an `access_requests` row at *verify* time;
  `open` gives a personal tenant through `onNoTenant`. Invitations are handled first on every login
  path, and every fallback gates on "has no memberships", not "is new". `POST /api/tenants` refuses
  a person with no membership whose access request is pending or rejected (403
  `pending_approval`; a global admin is not held by one), and one person's owned organisations stop
  at `MAX_OWNED_TENANTS_PER_USER` (default 10, global admins exempt, 403 `tenant_limit_reached`),
  counted under a lock on the user row so simultaneous grants cannot pass it. The ceiling holds
  wherever ownership is gained: creating an organisation, a promotion to `owner` on the members
  route, and accepting an `owner` invitation (refused, the invitation left pending). The same
  number bounds the organisations one person may CREATE per UTC day through `POST /api/tenants`
  (`tenant_creation_counters`, no foreign key to `tenants`, pruned nightly), so deleting an
  organisation frees a place under the ceiling but not the day's creation: one account's daily
  agent allowance is bounded by `AGENT_TENANT_DAILY_COST_USD` × the ceiling × 2 at most.
- **Roles (D10).** `owner | admin | member` plus `support` (minted from `/admin`, visible to the
  customer); `users.isGlobalAdmin` is a platform flag. Default for a new subject: owner/admin/support
  `manage`, member `read` with route-scoped writes. "Own row" is always a route predicate — **CASL
  conditions are used nowhere**. Deleting a tenant and changing `owner` need an explicit
  `role === 'owner'` check. The matrix lives in `apps/web/src/permissions/` (+ its `CLAUDE.md`).
- **Admin area.** `/admin` + `/api/admin/*` behind `globalAdminMiddleware` is the only cross-tenant
  surface. A global admin with no membership can still reach it, so there is always someone to
  approve the first request. Entering a tenant creates a real `support` membership; it lasts only
  as long as the role: when `is_global_admin` clears, by demotion, a claim going or a suspension,
  every `support` row of that person goes in the same transaction.
- **Invitations carry authority, so they have the same limits as a role change.** Only an
  owner-level actor (`isOwnerLevel`) may issue or resend an `owner` invitation, on the single and
  bulk routes alike (403 before any row). A member removed from a tenant takes their pending
  invitations with them, in the removal's transaction, on the members route and on every path that
  ends an `idp` or a `support` membership for good; a global admin's stay, because their authority
  is the platform flag (so leaving support revokes nothing). A role change ends the target's
  pending invitations the new role could not issue, in the same transaction (to `admin`: the
  `owner` ones; to `member`: all). And an invitation is accepted only while its issuer could still
  issue it: accept re-checks, inside its transaction, that the issuer exists, is not blocked and is
  a global admin or a member of the tenant whose role could issue the invitation's (`owner` needs
  an owner, `admin` / `member` an owner or an admin) — otherwise the row is marked revoked and
  the answer is 410 `invitation_revoked`. That covers every path that withdraws authority without
  revoking anything itself: an identity provider's block, a lost global-admin flag, an
  issuer-managed role change. The same rule (`issuerMayIssue`, one function) decides admission: a
  login counts as invited, under any `SIGNUP_MODE`, only for an open invitation whose issuer could
  still issue it, so a stale invitation admits no account under `invite_only`. Blocking a person
  from `/admin` revokes every pending invitation they issued, in every tenant and global admin or
  not, in the block's transaction; unblocking restores none.
  Accepting over an `idp` row leaves the
  row as it is (the invitation is still marked accepted). Mail is bounded by Postgres: a resend
  inside `INVITATION_RESEND_COOLDOWN_SECONDS` (five minutes) answers 429 and keeps the link
  already sent, and `invitation_send_counters` caps the mail per UTC day per person across every
  tenant (`INVITATION_EMAILS_PER_USER_PER_DAY`, 500) and per tenant
  (`INVITATION_EMAILS_PER_TENANT_PER_DAY`, 1000), an upsert per scope with a conditional update so
  simultaneous sends cannot pass it. A bulk invite stops at the limit and reports the rest as
  `failed` / `send_limit`; one that queued nothing is the 429 itself.
- **A suspended tenant is closed to its members and runs no agents.** `POST
  /api/admin/tenants/:id/suspend` sets `tenants.status`; every authenticating path (cookie, API
  key, `/ws`, the identity seam's tenant-taking methods) then answers 403 `tenant_suspended`, and
  the tenant's sockets close. `enqueueRun` / `enqueueRunBatch` refuse it the same way whoever asks
  (a plugin, an event trigger — `event.deliver` acknowledges the 403 rather than retrying). The
  suspension cancels the runs nothing is executing (`queued`, `awaiting_input`); a run already
  executing stops at its next cancel poll, and one whose Workflow reaches `execute` afterwards
  settles `cancelled` (status event `reason: 'tenant_suspended'`) before any model call.
  Reactivating starts nothing again: the cancelled runs stay cancelled. Its queued jobs do not run
  either: the jobs consumer reads `tenants.status` (one primary-key read) for every job whose
  payload names a tenant, and acks it unrun, with a log line, unless the tenant is `active` — a
  re-embed chain, an index or conversion, fact extraction (its next-day re-enqueue included),
  chat compaction, an email, an event delivery, a plugin's job. Dropped rather than deferred,
  because each restarts from its own state after reactivation: a re-embed from the stale count,
  a document from Retry (a dropped index or conversion leaves a `pending` document `failed`),
  compaction on the next turn. Two always run: `tenant.purge` (the teardown of a tenant that no
  longer exists) and `activity.record` (a record of what already happened). A deleted tenant's
  jobs read as not active too.
- **Deleting a tenant has two halves.** The `tenantRef()` FK cascade removes everything in
  Postgres; the **`tenant.purge`** job (§5) removes the R2 prefix and runs each plugin's
  `onTenantDeleted`. The queue binding is checked *before* the `DELETE`.
- **Groups and visibility (D29).** Tenants declare group types → groups → members;
  `AuthContext.groups` is resolved with the membership (a Bearer key uses its **creator's** groups, looked up on
  every request). A restrictable resource has an explicit `visibility` column (`tenant | groups`)
  plus a junction table. **The column decides and the rows only grant**, so an empty grant list
  means "owner and admins only". It never falls back to "public". The predicate is SQL in
  `services/access.ts` (`accessScopeOf` → `visibleDocuments` / plugin predicates), **ANDed with the
  tenant predicate, never substituted for it**. Admin-level roles bypass it. On kit resources groups grant READ only; a plugin may define its own
  grants over its own resources (`edit`, `publish`) and enforces them itself.
  Deleting a group that still grants something is 409 `group_in_use` (`?force=1` narrows).
  `access.changed` nudges the affected users.
- **Tenants managed by the OIDC issuer (IdP-managed tenancy, `OIDC_MANAGED_TENANCY`, §2).**
  `tenants.external_org_id` (unique, NULL for every tenant the app made) ties a tenant to an org at
  the issuer, and `tenant_users.source` (`manual | idp`) says who manages a membership. The
  sign-in reconcile creates a tenant per org in the claims, keeps its name in step, and adds or
  removes the person's `idp` rows; identity events change them between sign-ins.
  **A tenant made in the app is linked by slug — decided:** on an org's first sign-in, an
  unlinked tenant whose slug is the claim's `slug` becomes that org's tenant, so a tenant made by
  hand (or before managed tenancy) is not duplicated. The issuer's slug is trusted to name it; a
  tenant already linked to another org is never taken. When the slugs differ, a global admin links
  it (Admin → the organisation → Identity provider org; `PUT /api/admin/tenants/:id/external-org`,
  409 `external_org_taken` when another tenant holds the org), and can delete a duplicate the
  org's first sign-in made (`DELETE /api/admin/tenants/:id`, the owner's delete with its slug
  confirmation), which frees the org for the link. Under managed tenancy the issuer decides which
  organisations exist, so `POST /api/tenants` and a slug change on `PATCH /api/tenant` answer 409
  `idp_managed`, whoever asks, and the session's `canCreateTenant` is false so the UI offers no
  "Create organisation"; the slug-link path above is only reachable from a tenant that
  already had the slug, made by hand or before managed tenancy.
  `idp_synced_at` on both tables records when the issuer last spoke about the row, so a stale event
  is skipped. **A tenant created this way has no owner — decided:** managed tenancy never writes
  `owner` (or `support`), so the last-owner guard only ever counts owners a person chose, and
  losing an org at the issuer can never delete a tenant's last owner. Ownerless is a state the kit
  already allows: owner-only actions stay open to global admins (`isOwnerLevel`), and an owner can
  be made later from a MANUAL membership. An `idp` row is read-only in the app — role change and
  removal answer 409 `idp_managed` (People shows a "Managed" badge instead of controls); manual
  rows in the same tenant work as ever.
- **Isolation = predicates + inert RLS (D1)** — §4, `docs/RLS.md`.

**Known gaps:** no IdP group sync (SCIM/SAML claims); no group hierarchy or per-group roles;
conversations, runs, prompts and non-Knowledge files have no visibility; agent-written documents
are always `tenant`; no audit log beyond `activity_events`; no personal API keys (tenant keys only).
`AGENT_TENANT_DAILY_COST_USD` is per organisation, not per person — the creation limit above is
what bounds one account. A deleted organisation's `ai_usage` rows go with it (the FK cascade), so
the operator's record of what it spent is lost with the organisation.

## 2. Auth

- **Sessions are rows**: `user_sessions`, 30-day sliding TTL (`SESSION_TTL_MS`), never past the
  row's own `max_expires_at` when it has one (any sign-in under IdP-managed tenancy: sign-in +
  `OIDC_SESSION_MAX_AGE_DAYS`, at most 30 days, the cookie ending with it), cookie `__Host-session` (`HttpOnly`,
  `SameSite=Lax`, `Secure` outside development). `authMiddleware` resolves session → user →
  membership → groups → features in one query. The second strategy is a Bearer tenant API key
  (hashed, expiry, soft revoke), with scopes `authMiddleware` enforces on every request: `read`
  allows GET/HEAD/OPTIONS, `write` or `*` allows everything; anything else is 403
  `insufficient_scope`. The CASL check on the creator's role still applies on top. A key acts only
  within its organisation, plus its creator's own profile (`GET`/`PATCH /api/me`): `GET
  /api/tenants` lists that one organisation, and the routes about the person's whole account —
  `POST /api/tenants`, `GET /api/invitations/pending`, `POST /api/access-requests` — answer 403
  `insufficient_scope` to a key (`withAccountAuth`).
- **Magic link** is the zero-credential path: a 256-bit, 15-minute, single-use, SHA-256-hashed
  token. With no `RESEND_API_KEY` the URL is logged, except when `APP_ENV=production`, where it is
  never written to the logs. Past five sign-in mails to one mailbox in 15 minutes the route still
  answers 202 but mints nothing and sends nothing (KV, keyed by a hash of the canonical mailbox —
  lower-cased, a `+tag` dropped, and for `gmail.com` / `googlemail.com` the local part's dots
  dropped, so `a+1@x` and `a+2@x` share one window; the mail still goes to the address as typed). Opening the
  link consumes nothing: `GET /verify` redirects to `/magic-link/confirm`, and only its "Sign in"
  button (`POST /verify`, same-origin only) spends the token, so mail security scanners that fetch
  every link on delivery (Defender Safe Links, Mimecast) cannot. Dev-login exists and 404s in production.
- **OAuth is a registry** (D11): one generic `/auth/:provider` router over `ProviderDefinition`s
  (Google, Microsoft), each an `openid-client` code + PKCE flow (`providers/openid.ts`, HTTP Basic
  client auth). Microsoft discovers the `common` authority, so an `id_token` naming the person's own
  tenant is accepted and one naming another is refused; for Google and Microsoft an `id_token`'s
  claims are checked but not its signature (identity comes from userinfo / Graph). A token
  response must be `application/json`; an error body of any other type is `oauth_failed`.
  Redirect URIs come from `APP_URL`, accounts link by verified email (Microsoft: the user
  principal name, not `mail`, trusted only when its domain is among the signing-in directory's
  verified domains from Graph `/organization` — a personal account, an unlisted domain or a failed
  lookup is unverified), and an unverified address (`email_verified: false`) is refused with
  `email_unverified` only where it would match or admit an account: an identity already linked
  signs in, and link mode from a signed-in session links it. Tokens are AES-GCM
  encrypted under `OAUTH_ENCRYPTION_KEY`. The return path is `?returnUrl=`
  (`?redirectTo=` still accepted); the flow cookie carries state, PKCE verifier and a nonce.
- **Any OIDC issuer** (`providers/oidc.ts`): set `OIDC_ISSUER` + `OIDC_CLIENT_ID` (+ optional
  `OIDC_CLIENT_SECRET`) and an `oidc` provider appears, labelled `OIDC_LABEL`. Endpoints come from
  discovery (cached per isolate, refused unless its `issuer` matches exactly); code + PKCE S256 +
  `nonce`; the `id_token` is verified with jose against the issuer's JWKS (`iss`, `aud`, `exp`,
  `nonce`; an unknown `kid` refetches the set — rotation). The identity key is `${iss}|${sub}` in
  `oauth_providers.provider_user_id`, so no migration; a changed issuer falls back to
  verified-email linking. The issuer must assert `email_verified: true`: a missing flag is
  unverified (refused as `email_unverified` — no email linking, no admission) unless
  `OIDC_TRUST_EMAIL=true` opts in an issuer that controls the claim (single-tenant Entra); an
  explicit `false` is always refused. `AUTH_OIDC_ONLY=true` leaves the login page one "Continue with <label>" button (never an
  automatic redirect: a live issuer session must not become a silent login) and refuses
  `/auth/google|microsoft`. It also turns the magic-link routes off on the server: `POST /auth/magic-link/request`
  mints nothing (same 202), `POST /verify` answers `/login?error=oidc_only`, and `/auth/methods` says
  `magicLink: false`. Invitation emails carry an accept URL, not a magic link, so nothing else changes. With an `end_session_endpoint`, `POST /auth/logout` answers
  `200 { endSessionUrl }` (RP-initiated logout back to `/login?signedOut=1`, sent as both
  `post_logout_redirect_uri` and `logout_uri` — Amazon Cognito returns only on the latter); otherwise
  204. A token exchange the issuer refuses with HTTP 400 `UserLambdaValidationException` (a Cognito
  Pre Token Lambda denying the person) lands on `/login?error=no_access` — "You don't have access to
  this app" — not the generic error. Setup: `SETUP.md` → "Sign in with any OIDC issuer".
- **IdP-managed tenancy (`OIDC_MANAGED_TENANCY=true`)**: the issuer, not the app, says which of
  its orgs the person may use the app in. Its id_token carries them under `OIDC_ORGS_CLAIM`
  (default `orgs`): `[{ id, name, slug?, role }]`. The callback reads them from the payload
  `oidc.ts` already verified (zod, `@rocketflare/shared/idp`; missing or malformed → ignored and
  logged, the sign-in is plain OIDC) and runs `reconcileIdpClaims` (`services/idp-tenancy.ts`) on
  **every** sign-in, before `completeLogin` — linked users never reach `admitUser`, so it cannot
  live there. Roles map through `OIDC_ROLE_MAP` (`issuerRole:admin|member` pairs; an unmapped role
  skips the org); an existing manual admin/member row is adopted as `idp`, an `owner` or `support`
  row is left alone. An org gone from the claims deletes its `idp` row (with the member's tenant
  settings) and unpins sessions pinned to it. Admission comes from the claims, not `SIGNUP_MODE`:
  a person with an org, `OIDC_ADMIT_CLAIM` true or `OIDC_GLOBAL_ADMIN_CLAIM` true is created if
  new and never given an access request (any pending one is closed once they hold a tenant). The
  global-admin claim sets `is_global_admin` with `global_admin_source = 'idp'`; the claim going
  clears it only when that source is `idp` (the admin console writes `manual`). A person admitted
  with no org gets the normal no-tenant pages. Every session, a magic link's or a dev login's as
  much as an OIDC one, ends `OIDC_SESSION_MAX_AGE_DAYS` (default 7, at most 30) after sign-in
  however active it is, so everyone is reconciled from fresh claims at least that often. Writes
  never overwrite a newer change: a sign-in stamps what it writes with the token's `iat`, never
  over a row an event stamped later, and updates a membership only as it read it (an owner
  promotion in between wins; a row removed in between is inserted again, since the claims grant
  it); a removal deletes a row only if nothing has stamped it since the event. A first sign-in
  whose new tenant's slug clashes picks again, up to five times. Tenancy is §1.
- **Identity events (`POST /api/identity/events`)**: between sign-ins the issuer posts signed
  events (Standard Webhooks: `webhook-id`, `webhook-timestamp`, `webhook-signature`, verified
  against `IDENTITY_WEBHOOK_SECRET` over the raw body, five minutes' tolerance, two signatures
  during a rotation — `auth/standard-webhooks.ts`). `person.suspended`, `membership.removed`,
  `membership.role_changed`, `grant.revoked` (org-wide, or one person) and `org.suspended` remove
  or change `idp` memberships; `person.suspended` also ends the person's sessions and the global-admin
  role the issuer granted (a `manual` grant stays); `org.renamed`
  renames the tenant. Each does what the next sign-in's reconcile would, so nothing outlasts a
  sign-in that says otherwise (a suspended org's members are back when the issuer lets them sign
  in). The person is found by the OIDC link (`<issuer>|<sub>`), else by email: an event carrying a
  `sub` with no link can still reach an account by email, but never one linked to another subject at
  this issuer, while an event with no `sub` has only the email (a person before their first
  sign-in); the org by
  `external_org_id`. Applied before answering, idempotently and in any order: an event older than
  the row's `idp_synced_at` is stale and skipped, and a role change never creates a membership.
  204 for applied, stale, unknown person or org, and unknown type; 400 for a malformed known type;
  401 for a bad signature; 404 when not configured.
- **Plugin sign-in (the identity seam, §16)**: a plugin that proves a person itself — a SAML
  assertion, a per-tenant OIDC connection — finishes with `identityFor(c, id).signIn({ subject,
  email, emailVerified, name, tenantId?, role? })` (`plugins/api/identity.ts`), never by writing
  a session. The kit links the identity in `oauth_providers` under provider `plugin:<id>` (the
  plugin namespaces `subject`, e.g. `<connection>|<nameId>`), else finds the person by email, else
  `admitUser`s them — by `SIGNUP_MODE`, or as an IdP admission (`admittedBy: 'idp'`) when
  `tenantId` + `role` are asserted, which also upserts an `idp` membership through the same
  primitive the OIDC reconcile uses. Then `completeLogin` pins that tenant and sets the cookie.
  `emailVerified: false`, a blocked person, a stale tenant and a subject linked elsewhere are the
  usual `/login?error=` redirects. `ServerPlugin.loginMethods(cfg)` adds buttons to the login page
  (`GET /auth/methods` → `pluginMethods`, `<plugin id>:<method id>`), each a full-page navigation
  to a `startPath` under the plugin's own `/api/hooks/<id>/`, optionally behind an email field
  (`askEmail` → `?email=`, home-realm discovery). A method may carry `errors`, copy for its own
  `?error=<plugin id>.<name>` codes: its routes redirect a failed navigation to `/login` with one
  (and `?email=`, which refills that method's field), and the page shows the server-sent copy,
  never URL text; a code outside its namespace drops the method. They show under `AUTH_OIDC_ONLY` too: they are
  SSO, and `oidcOnly` turns the kit's non-SSO methods off. A plugin link is not listed on the profile's
  sign-in methods and cannot be unlinked there (`DELETE /auth/providers/:provider` knows only the
  kit's providers).
- **SSO required per email domain (`ServerPlugin.ssoPolicy`, `api/auth/sso-policy.ts`)**: once an
  organisation turns SSO on, its people may sign in ONLY through it. Core cannot know which
  domains are theirs — the connections and their DNS-verified domains live in a plugin — so it
  ASKS every installed plugin, in parallel, once per sign-in ATTEMPT (never per request: a minted
  session is trusted until it ends): `{ required: true, methodId }` names one of that plugin's own
  `loginMethods`, or `null`. Enforced server-side at: the magic-link request (no token is minted;
  a token-free "use single sign-on" email links to the login page instead — still 202 with the
  same body, so nothing leaks to the requester, and the real person learns where to go rather than
  waiting for a link that never comes), magic-link verify (a link minted before the policy
  existed is spent and refused), the Google / Microsoft / OIDC callback (the asserted email AND a
  linked account's own, checked before anyone is admitted or linked), dev login (403
  `sso_required` + `details.method`, so development shows what production does) and every
  plugin's `identityFor().signIn` — which passes only for a plugin that CLAIMED the address and,
  when its policy names a `connectionId`, only through that connection, so a second tenant's
  connection cannot sidestep the first's. Where the sign-in involves two addresses (asserted and
  account), each must be claimed by the connection signing in. `/auth/cli` and invitation acceptance
  need a session, so they inherit it; an invitee's magic-link request gets the SSO email with the
  invite as `returnUrl`. Refusals land on `/login?error=sso_required&method=<plugin id>:<method id>`
  and the login page offers that method directly (email prefilled from the SSO email's link),
  using the label `/auth/methods` gives — never text from the URL. **Decided:** a policy that
  THROWS (or answers garbage) **fails closed** for that email, logged at `error` — failing open
  would hand the magic-link door to anyone who can make the lookup fail; the claim is attributed to
  the throwing plugin, so its own sign-in still works. **Break-glass:** `BOOTSTRAP_ADMIN_EMAILS`
  are exempt (logged at `warn` when a claim is bypassed) — they live in deployment config only an
  operator can change, so a broken connection can never lock out the console that would fix it;
  `is_global_admin` alone is not exempt (it is a database flag). A `methodId` the plugin does not
  offer keeps the requirement and drops the hint.
- **Hardening (D12)**: random tokens hashed with SHA-256, a required encryption key, CSRF by origin
  allow-list (Bearer is exempt), and a KV sliding-window rate limit on login routes that no-ops
  without `RATE_LIMIT_KV`. Return paths pass one rule, `isSameOriginPath` in
  `@rocketflare/shared/paths`: no control character or backslash anywhere, then same-origin
  (`redirectToSchema`, `safeRedirectPath`, `safeReturnUrl`). The OAuth flow cookie is `__Host-`.
- **CLI handoff (D26)**: `GET /auth/cli?redirect_uri=http://127.0.0.1:<port>/callback` allows only
  loopback targets and creates nothing: a signed-in person goes to `/cli/confirm`, and only its
  button (`POST /auth/cli/confirm`) mints the revocable tenant key `cli:<hostname>` and answers the
  loopback URL to navigate to. The CLI sends a random per-login `state`, the server passes it back,
  and the CLI ignores a callback without it. Details: `.claude/rules/api.md`.

**Known gaps:** no provider token refresh; the rate limit is approximate; no session management UI
beyond "log out everywhere"; a personal Microsoft account cannot sign up or be matched by address
— it signs in only after being linked from account settings, and a directory's verified domains
are read on each sign-in, never cached; CLI keys differ from other keys only by name. OIDC: one issuer per
deployment; the `groups` claim is read into the profile but **not stored or mapped** to kit groups
or roles; no `id_token_hint` on logout (id_tokens are not kept, so the issuer may ask to confirm);
no back-channel or front-channel logout; `OIDC_TRUST_EMAIL=true` trusts every email the issuer
sends (no per-domain rule) — set it only for an issuer that controls the `email` claim; the client secret
is sent as `client_secret_basic` only (no `private_key_jwt`). IdP-managed tenancy: without
`IDENTITY_WEBHOOK_SECRET` claims are as fresh as the last sign-in, so a removal waits for the next
sign-in or the session's end; an identity event the issuer gives up on is healed only then too;
events are applied in the request, not queued; a removal is not remembered once applied (the row
goes), so a sign-in whose id_token was issued in the second or two before a removal event, or
before a concurrent sign-in that cleared global admin, can restore what that removed until the next
sign-in or the session's end; one orgs claim, one role map and no per-org role
overrides; the app writes nothing back to the issuer; the slug is taken from the claim once and
never follows a later rename; `person.suspended` revokes no API keys: a key acts as its creator,
so the keys in the tenants they lost stop working, and those in their manual tenants do not.
Plugin sign-in: the kit trusts the plugin's word on `subject`, `email`, `emailVerified` and the
tenant entirely (proving them is the plugin's job); one plugin may not name another's id, but
nothing enforces that the id passed to `identityFor` is the caller's own; in multi mode
`deprovision` is per tenant by design and never blocks — a person a tenant's IdP deactivates keeps
their other tenants, the sessions selected to them and their keys there, and a session with NO
pinned tenant is not ended (it re-resolves to another membership, or to none); in single mode it
blocks (§16), but `removeMembership` alone leaves a signed-in person with no tenant, who can file
an access request; an IdP block is lifted only by `setMembership`, so a plugin that reactivates
without one leaves the person blocked; a link keeps working after the proof behind it is gone
(a domain removed from a connection, an address later added to `BOOTSTRAP_ADMIN_EMAILS`): the
plugin re-checks its domains before `signIn`; and a plugin link is invisible on the profile
page. SSO required: sessions that already exist when a domain turns it on are not ended
(they run to their TTL), API keys are untouched, a throwing policy locks that email's non-SSO
sign-in until it recovers (only the bootstrap admins are exempt), linking a provider to a
signed-in account is not checked, and the host trusts the plugin's word that it owns the domain.

## 3. API shell

- **One Worker, one app** (D5): `src/worker.ts` exports `{ fetch, queue, scheduled }` plus the
  DO/Workflow classes; `api/index.ts` exports `app` so tests call `app.request(req, env, ctx)`.
- **Config (D3/D4)**: `loadConfig(env)` validates `Cloudflare.Env` with zod once per isolate.
  Routes read `c.get('config')`. `APP_ENV` replaces `NODE_ENV`, and `process.env` is banned in `src/`.
- **Middleware order is deliberate** (error envelope → logger → config → security headers → body
  limit → CORS → CSRF → DB → tracing → mounts). Auth is per mount. The ASSETS catch-all 404s every
  API prefix, so a missing route never returns `index.html`. Order and exceptions:
  `.claude/rules/api.md`.
- **Body limits**: 1 MB on `/api/*`, `/auth/*` and a plugin's prefixes outside `/api`, before any
  parsing (413 `payload_too_large`). Beneath an upload prefix (`/api/files`,
  `/api/ai/documents/upload`, a plugin's `uploadPaths`) a JSON body keeps the 1 MB cap, and any
  other body is capped at `MAX_UPLOAD_PATH_BODY_BYTES` (10 MB + 64 KB multipart overhead, the
  largest file an upload route may take); each upload route mounts its own tighter cap and checks
  the exact per-file size itself. A public mount's `bodyLimitBytes` replaces the cap (§16).
- **Contracts (D13)**: zod schemas from `@rocketflare/shared` are used by the server, UI and CLI.
  There is no `hono/client` RPC. Errors are `{ error, statusCode, code?, details? }` everywhere,
  and success bodies are bare.
- **Routes are thin** and never run long work (§5).
- **Local dev ports**: Vite :3000 proxies to `wrangler dev` :3001, both `strictPort`, unless
  `DEV_UI_PORT` / `DEV_API_PORT` are set (shell, then `.dev.vars`; `scripts/lib/dev-ports.mjs` is the
  one reader). `APP_URL` follows the UI port by hand — the Worker cannot read the shell — and
  outside production CORS/CSRF also allow the loopback twin of `APP_URL` and of the request's own
  loopback origin. `SETUP.md` 1.6.
- **Local Workers AI switch**: `DEV_WORKERS_AI=off` (shell, then `.dev.vars`; `pnpm bootstrap
  --offline` writes it, `--online` sets it `on`) makes every local `wrangler dev` launch —
  `pnpm dev`, `pnpm dev:api`, `pnpm dev:tunnel` — run from `apps/web/.wrangler.offline.toml`, a
  git-ignored copy of `wrangler.toml` with `[ai]` commented out, regenerated at each launch
  (`scripts/lib/dev-ai.mjs`). The Worker then has no `AI` at all, so the resolver falls through
  exactly as on a Worker deployed without the binding. The tracked tomls and
  `worker-configuration.d.ts` are identical online or offline, so an offline copy stays clean for
  commits and `kit:upgrade`. Not `wrangler dev --local`: that keeps an `env.AI` stub that throws
  when called. Any bootstrap run restores an `[ai]` block an older release commented out of the
  tomls, carrying the offline choice into `.dev.vars`. `SETUP.md` 1.6.

- **Tunnel**: `pnpm dev:tunnel` runs cfld through `apps/web/scripts/cfld.mjs`. That script
  downloads cloudflared (pinned in `scripts/lib/cloudflared.mjs`) the first time there is no
  override, no PATH binary and no managed copy. `pnpm install` never builds the package.
  `SETUP.md` 1.10.

**Known gaps:** while `pnpm dev:tunnel` runs, the development instance is public, and its
password-less dev sign-in (`POST /auth/dev-login`, any email in development) with it: anyone who
learns the hostname can sign in as any user (`SETUP.md` 1.10 — dummy data, stop it when done);
`pnpm dev:tunnel` always targets :3000 (cfld reads `package.json`); `pnpm dev:api`
alone reads `DEV_API_PORT` from the shell only, not `.dev.vars`; no `/api/ready` smoke step against a preview; no OpenAPI (`@hono/zod-openapi` is the
path); no per-PR previews.

## 4. Database

- **Two drivers, one client per request (D35, replacing D2's "postgres.js only")**:
  `DATABASE_DRIVER` picks Drizzle over the Neon serverless driver (`neon`: neon-http per query, a
  WebSocket `Pool` opened for `db.transaction`) or over `postgres.js` (`postgres`, through
  Hyperdrive — any Postgres). A missing var means `postgres`; the kit's tomls say `neon`;
  `.dev.vars` and `.env.test` say `postgres`, so local work and the suite run postgres.js; the seam
  below is what makes that a safe stand-in for the deployed driver.
  `openDatabase(env)` (`db/client.ts`) is the one resolver — URL `PREVIEW_DATABASE_URL ??
  DATABASE_URL` under `neon`, `?? HYPERDRIVE.connectionString ??` in between under `postgres` — and
  the client is built per request / consumer message / step / cron run and closed in `waitUntil` or
  `finally`. No LISTEN/NOTIFY, advisory lock or PREPARE on the request path under either.
  Why two: Hyperdrive caps an account at 25 configs (a fleet of apps cannot each have one) and
  sandboxes have no TCP out, but Hyperdrive is also how a copy reaches a Postgres that is not Neon.
  Detail and the switch: `docs/DEPLOY.md` § Database driver, `docs/NEON-DRIVER.md`.
- **The driver seam: code never sees the driver** (`src/db/CLAUDE.md`). `db/client.ts` is the only
  place the two differ, and every divergence is either normalised there or banned everywhere else.
  Normalised: a raw `db.execute()` is `unknown` (`Database` is drizzle's `PgDatabase` base) and is
  read with `rows()` / `affected()`, because postgres.js returns an array with `.count` and Neon
  `{ rows, rowCount }`; raw arrays parse to arrays under both (Neon's own parsers installed on
  postgres.js, `ARRAY_PARSERS`); a SQLSTATE is read with `pgErrorCode()` / `isUniqueViolation()`.
  Raw timestamps are Postgres's text under both. Banned by `tests/config/driver-results.test.ts`
  (an AST scan over `src/`, installed plugins included): a cast, index or `.rows`/`.count` read on
  a raw result, a driver import, a SQLSTATE compared by hand, session state (a statement `SET`,
  `set_config(…, false)`, a session advisory lock, a temp table) outside a transaction callback —
  neon-http runs every other query on a fresh connection — and `LISTEN` anywhere.
- **Proved under both drivers.** The `driver` vitest project is the conformance suite for the seam:
  each test states one equivalence and passes unchanged under both drivers
  (`tests/config/driver-conformance.test.ts` fails a skip or a per-driver expectation).
  `pnpm test` runs the suite under `postgres`, then the `driver` project under `neon` through the
  local proxy — so every gate, a copy's CI included, proves the deployed path. `kit.yml` runs the
  whole suite under `neon` with the CI plugins installed (`GATE_SUITE_DRIVER=neon`); locally
  `GATE_SUITE_DRIVER=neon pnpm gate test` does the same, and `pnpm dev:db:up --neon` runs the
  deployed driver on the local database. Time limits scale by one latency factor per target
  (`vitest.config.ts`: 1 local `postgres`, 4 through the proxy, 12 on a real Neon branch); no test
  carries a budget of its own.
- **The gate** (`pnpm gate`, `scripts/lib/gate-lib.mjs`): lint → typecheck → test → build,
  stopping at the first failure (`--keep-going` runs all; `pnpm gate <step…>` and `--skip` are for
  iterating locally — no workflow passes `--skip`). It is the pre-commit gate, a copy's one CI job
  and Launch's ship gate. `pnpm gate --list --json` is the contract a step-by-step runner reads:
  `{ schema: 1, steps: [{ id, command, database }] }` in run order, validated by
  `packages/shared/src/gate.ts`; `schema` rises only when an existing field changes meaning, so a
  reader tolerates a new step or field. There is no generated-files step: `typecheck` regenerates
  `worker-configuration.d.ts` and compiles against it (commit what changes); the
  `docs/plugin-api.md` diff is the kit's own check (`kit.yml`), since a copy publishes no plugin
  API; `pnpm plugin check` runs at the end of `plugin add|upgrade --apply` (exit 8 when the written
  tree fails it) and in `plugin-ci.yml`.
- **Verified once (opt-in, for an app Launch ships).** After a green sandbox gate Launch's GitHub
  App posts a `launch/gate` check run keyed by the tree (`external_id: tree:<sha>`). With the
  repository variable `LAUNCH_GATE_APP_ID` set to that App's id, the first step of `ci.yml`'s
  `Gate` job (`scripts/gate-verified.mjs`, rules in `scripts/lib/gate-verified-lib.mjs`) looks for one from
  THAT app, `success`, for the tree CI is about to test — on a pull request the merge commit's tree,
  found on the PR head (so it holds only while the branch contains main's tip); on a push to main
  the pushed commit's tree, found on the commit or its PRs' heads. Found, `Gate` runs gitleaks and
  `pnpm gate build` only; anything else — unset, another app, another tree, an API error — runs the
  full gate. Unset, no lookup runs at all. Trust is the app id: anyone with `checks: write` can name
  a check `launch/gate`, only Launch's App can post one under its id.
- **`pnpm test` picks its target from the environment** (`scripts/lib/test-plan.mjs`), never by
  probing, and prints it first. **Local** (the default): it starts the compose test Postgres and
  Neon proxy itself (`docker compose … --profile neon up -d --wait`; Docker down is a failure that
  names both fixes, never a skip), then every package, the web suite under `postgres`, and the
  `driver` project under `neon`. The narrow scripts (`pnpm web test:api|ui|config|driver`) are the
  inner loop: `postgres`, no compose management.
- **Remote target — an ephemeral test database** (`pnpm test` with `TEST_DATABASE_BRANCH` set): the
  whole gate's tests where there is no Docker and only 443 out — a coding sandbox, whose
  orchestrator (Launch) creates a throwaway Neon branch per gate attempt and passes its owner
  connection string. The runner sets `TEST_DATABASE_EPHEMERAL=1`, `DATABASE_DRIVER=neon`, an empty
  `APP_DATABASE_URL` (the app role stays NOLOGIN) and runs every web project; the postgres half of
  the conformance pass is skipped (no TCP) and said so. `TEST_DATABASE_EPHEMERAL=1` without a
  branch, or `GATE_SUITE_DRIVER=postgres` with one, is refused. `safetyCheck()` (`tests/helpers/db-safety.ts`) still
  refuses any non-local `DATABASE_URL` unless ALL hold: that profile, the `neon` driver, a
  `*.neon.tech` host, `TEST_DATABASE_BRANCH` matching `^gate-[a-z0-9]+-\d+$`, and
  `TEST_DATABASE_ENDPOINT` equal to the `ep-…` id in the URL. The branch name is not in a Neon
  connection string, so the name alone is only a claim; the endpoint id is, and binds the claim to
  that URL (a stale opt-in in a shell cannot bless another database). The profile runs 2 forks
  (`TEST_MAX_WORKERS` overrides; a small Neon compute allows ~100 connections, the local sizing
  assumes 300), a 60 s test and 120 s hook limit (the factor of 12: real round trips, a
  cold-starting compute; `TEST_LATENCY_FACTOR` raises the factor on any target — a slow sandbox
  machine running a test by hand — and never lowers it, `tests/helpers/latency.ts`), and
  skips `db-roles.test.ts` (postgres.js over TCP, and a superuser to make owner roles). Global setup
  is unchanged: role → migrate → grants → truncate → seed, as the connecting role; its FIRST
  connection (`db-roles`) waits for the database (`waitForDatabase`, `scripts/lib/sql.ts`) exactly
  as the migrator does, because the neon driver reports a WebSocket that failed before Postgres
  answered as an `ErrorEvent` with no message, and one such failure used to fail the whole run.
  Every Neon `Pool` comes from `createNeonPool` (`db/client.ts`), whose `error` listeners turn a
  dropped connection into a rejected query rather than an uncaught exception that kills the run.
  `migrate.ts`,
  `db-roles.ts` and `seed.ts` `process.exit` when done, as `db:check` does: Cloudflare's container
  egress interceptor never ends a closed database WebSocket's stream, so Node would never exit.
- **Conventions**: one file per table, `tenantRef()` + `timestamps()` (`timestamptz`), append-only
  enums, `vector(1024)` (a new dimension means a new table). `migrate.ts` creates the `vector`
  extension first. Detail: `.claude/rules/database.md`.
- **Local port is chosen** (`scripts/dev-db.mjs`): each checkout gets its own compose project and
  port, written back to `DATABASE_URL`, so two copies never share a database.
- **Or an existing database** (`pnpm bootstrap --db-url <url>`): for a machine with no Docker (a
  coding sandbox on a Neon branch). The URL goes into `DATABASE_URL` and nothing is started; a
  `*.neon.tech` URL also sets `DATABASE_DRIVER=neon` there (HTTPS + WebSocket only, which is what a
  sandbox allows; `--driver` overrides). An
  off-box `DATABASE_URL` (not loopback) is left alone by `dev-db.mjs` and skips preflight's Docker
  checks. The seed runs there with `SEED_ALLOW_REMOTE=1`. A sandbox that already installed, made
  the database and knows it is migrated says so instead of paying for it again: `--no-install`,
  `ROCKETFLARE_BOOTSTRAP_SKIP=<steps>` (any of steps 1–8 by name) and `ROCKETFLARE_ALLOW_ROOT=1`
  (its commands run as root; the container is the boundary) — `SETUP.md` Part 1.
- **Migrations**: `db:generate` → read the SQL → `db:migrate` (role → migrations → grants).
  Migrations are forward-only. `db:generate` applies every migration to a scratch database on the
  local dev Postgres whenever it writes one, and names the statement Postgres refused (drizzle-kit
  can order a composite FK before the UNIQUE it needs); outside the gate, skipped for a non-local URL.
- **Cross-tenant allow-list**: `tests/config/unscoped-allowlist.test.ts` fails a function that
  queries a `tenant_id` table without naming a tenant. Each exception carries a reason. It does
  not prove `admin.ts` is the only cross-tenant surface.
- **RLS** ships inert: every tenant table has `tenantIsolation()` (enforced by `rls-coverage`),
  and `TENANT_SCOPE_MODE=enforce` waits on the spike in `docs/RLS.md`.

**Known gaps:** the RLS spike has not been run; no read replicas; the local Neon proxy is a
community image, mirrored to `ghcr.io/rocketflare-dev` and rebuilt with our start script (pinned by digest) — Neon's official "Neon Local"
needs a cloud account; `neon` in deployment has no read cache and pays a round trip per query
(p95 is measured per app when it switches, not gated); the seam's guard catches only the
divergences it knows — a new kind (a driver release that parses something differently) surfaces
in `kit.yml`'s full-neon pass or in production, not in a copy's gate, whose suite runs `postgres`;
the proxy image is pulled by every local `pnpm test` (the narrow scripts never pull it); the TEST
database is pinned to
5433, so two checkouts cannot run `pnpm test` at once (each app has its own Compose project,
`<slug>-test`, so switching checkouts no longer recreates the other's container). `--db-url` with a loopback URL (a native
Postgres) still looks like this checkout's Docker database to preflight and `dev:db:*`, and a
re-run of the bootstrap without the flag checks for Docker again. The remote target is proven in
the kit only through the local Neon proxy: against a real Neon branch, the owner role's
`ALTER ROLE`s on an app role someone else created, the connection count and the time limits are
the caller's to prove.

## 5. Background work and realtime

**A route never runs long work (D7).** Anything under 30 s total goes to `JOBS_QUEUE`, multi-step
work goes to `AGENT_RUN_WORKFLOW`, and cron only dispatches.

- **Jobs**: one queue, envelope `{ id, type, payload, enqueuedAt }`, variants are DATA
  (`CORE_JOB_VARIANTS` + plugin `jobs`). A mapped handler table proves completeness, so there is no
  switch. `type` is the version seam (`x.v2`). An invalid envelope is acked; a handler error retries
  with backoff up to `max_retries`. A missing binding throws. Consumers await everything and never
  use `waitUntil`. Queued today: `tenant.purge`, invitation and access-decision emails,
  `document.index`/`document.convert`/`document.reembed`, `chat.compact`. The magic link stays
  inline. A message that fails all its `max_retries` lands in the dead-letter queue
  (`<app>-jobs-dlq`, `-staging` on staging; no consumer bound, inspected from the dashboard) rather
  than being deleted.
  Detail: `.claude/rules/api.md`.
- **Workflow**: `AgentRunWorkflow` (§9). **Concurrency is a DB claim row, never a `Map`**:
  `ACTIVE_RUN_STATUSES` (exclusive index, includes parked runs) ⊃ `CLAIMABLE_RUN_STATUSES`
  (the claim). Keep those two lists separate. A lost instance is settled on read, and by the
  `sweepLostRuns` cron for a run nobody reads (below).
- **Cron**: `scheduled.ts` looks up the task by expression. `0 4 * * *` prunes; `*/10 * * * *`
  runs `sweepLostRuns` — up to 100 active runs untouched for 10 minutes, oldest first, each
  through `sweepRun`: a `queued` row that never got its instance gets one, `queued`/`running`
  goes through `reconcileRun` (settles only what the runtime says has ended), `awaiting_input`
  through `expireParkedRun`. Without it a dead run nobody opens holds its exclusive slot and counts
  toward the tenant cap forever. Plugins add their own tasks, and each expression must appear in
  both tomls.
- **Realtime (D8)**: `NotificationsHub` DO, one per tenant, stateless, using the hibernation API
  with RPC publish. `GET /ws` resolves the cookie itself, and refuses an `Origin` outside the same
  allowlist as CORS and CSRF. Removing a member, signing out, blocking a person, suspending a tenant
  and the identity provider's removals close the affected sockets (`close{User,Session,Tenant}Sockets`,
  code 4001). **"DB is the truth, WebSocket is a
  nudge"**: events carry ids, and the UI invalidates the query-key roots from
  `REALTIME_INVALIDATIONS`. The `entity` of `entity.changed` IS the query-key root. All nudges go
  through `services/realtime.ts` inside `defer`, after commit.

**Known gaps:** `/api/admin` paths do not nudge; `notification.read` is never emitted;
`activity.record` has no producer; the DO 101 upgrade is untestable under Node; nothing reads or
replays the dead-letter queue (no consumer, no alert, no admin view); no vitest-pool-workers smoke
project.

## 6. Email and storage

- **Email**: Resend over `fetch`, `sendEmail(...)`, neutral templates. With no key, messages are
  logged (`[email:dev]`, without the link when `APP_ENV=production`), never errors. The magic link is sent inline; other email is `email.send`
  jobs.
- **Storage (D23)**: the `StorageService` seam over the `FILES` R2 binding. Keys are
  `tenants/<tenantId>/<scope>/<uuid>-<name>`. Bytes stream through the Worker (no presigned
  URLs). The `files` table is the immutable index and the only thing the browser can name. Writes
  go object first, then row, and a failed insert deletes the object.
- **`/api/files`**: upload with per-scope type/size checks (413/415); tenant-scoped read (another
  tenant's file is 404) with ETag/304; **only allowlisted types render inline, everything else is
  an attachment**. Uploaders can delete their own files, admins any. A document-owned file is 409
  `owned_by_document`.
- **Framing is opt-in per response**: only a route that proved the type (`isEmbeddableMimeType`, PDF)
  sets `embeddable`, which relaxes `DENY` to `SAMEORIGIN` for that one response. It is set before
  the 304 early return. Never use a path allowlist for this.
- A missing `FILES` binding is 503 `storage_not_configured`. `tenant.purge` pages through the
  tenant prefix and is idempotent.

**Known gaps:** `avatarUrl` is global but the object is tenant-scoped (initials fallback elsewhere);
re-uploads leave the old object; no listing endpoint, quotas or presigned URLs; unbranded templates.

## 7. UI shell

- **Design tokens (D20)**: two DaisyUI themes in `shared/theme-tokens.css` (read by `ui/index.css` and by public-site stylesheets), where the brand hexes are the only
  hex values; `contrast.test.ts` gates them. Tailwind scanning is `source(none)` + explicit
  `@source` lines. A plugin's pages get the `../plugins/**/ui/**` line, and precompiled dependency
  CSS gets none. The floors and pairs live in `scripts/lib/contrast.mjs`, which the test and the
  design pages share.
- **Design pages** (`pnpm design:docs`, `scripts/design-docs.mjs`): renders `docs/design/*.md` (a
  numeric prefix orders them; the first is `index.html`) and inlines `docs/design/diagrams/*.svg`
  into `docs/design/html/`: static HTML pages in the app's own tokens, light and dark, committed
  with the design. `/rf-design` writes the markdown and runs it. The markdown is untrusted: the
  renderer (`scripts/lib/markdown-lite.mjs`) knows a fixed subset and escapes everything else, and an
  SVG is re-serialised through an allowlist (`scripts/lib/svg-sanitize.mjs`). A brand being tried
  goes in `docs/design/brand.css`, written in the token files' own block shapes (`@theme`,
  `@plugin "daisyui/theme"`, `[data-theme]`, matched by the `-light`/`-dark` suffix) and holding
  only what it changes. `scripts/lib/brand.mjs` layers it per property over `theme-tokens.css`
  and `index.css`: the pages' stylesheet, `--contrast` (the gate's floors, failing pairs printed per
  theme) and `--apply-brand` (writes each property into whichever file defines it, plus
  `<meta name="theme-color">`) all read that one result, and each warns about a derived tone
  (`--focus-ring`, `--surface-active`, `--tone-*`) that a changed colour left at the kit's value.
  `--check` exits 1 when the pages are stale. The output is deterministic, and a rebuild deletes only
  pages carrying the generator's meta tag. The script is not kit-only, so it ships in every copy.
- **Providers**: ErrorBoundary → QueryClient → Auth → Ability → WebSocket → Router. A global 401
  clears the cache and redirects to `/login?returnUrl=`.
- **Guards**: one `RequireGuard` primitive; nav items use the same guard as their page.
  `/login?as=` dev sign-in only works when the server reports `devLogin` and the email is a seeded
  account.
- **Data**: `api-client.ts` parses with shared schemas, there is one hook file per resource, and
  keys come from `queryKeys`. zustand holds only websocket state. Detail: `.claude/rules/ui.md`,
  `apps/web/src/ui/CLAUDE.md`.

**Known gaps:** no route preloading; no "system" theme or cross-tab sync; the dev quick-login list
is hard-coded. The rendered design's markdown has no raw HTML, footnotes, task lists or reference-style
links. It inlines only SVGs under `docs/design/diagrams/`, and a brand font is linked from Google
Fonts whenever it is not a known system font, without checking that Google serves it.

## 8. Analytics

**The `analytics` PLUGIN, opt-in (D31).** `plugins/analytics` in
`rocketflare-dev/rocketflare-plugins`; `defaultPlugins` is empty, so a fresh clone has no
dashboards until `/rf-plugin add analytics` (SETUP.md §2.7). Once installed, its docs are its own
`CLAUDE.md` files. drizzle-cube cubes scope every `sql()` by tenant, dashboards are jsonb `DashboardConfig`s
restrictable to groups, fact tables rebuild on the `:15` cron, and its cube-isolation test is
mandatory. The kit core knows nothing about drizzle-cube, and other plugins extend it through
`analyticsExtensions({...})`. The kit's CI installs it as a canary (`.github/ci-plugins.json`), so a
kit change that breaks it fails on the kit's pull request.

The kit still owns `activity_events`, the catch-all/`run_worker_first`/Vite-proxy files its
prefixes must be added to, and the visibility registry it registers into.

**Known gaps (kit side):** `activity_events` has no retention; nothing proves a plugin's cron reached
the tomls beyond parity between the two files; fact refresh/check need a running server and CLI;
opting in is a manual `plugin add` — the bootstrap has no flag for it.

## 9. AI layer

Server: `api/services/{ai,agents}/**` (read their `CLAUDE.md`), `services/prompts.ts`,
`api/workflows/agent-run.ts`. Contracts: `packages/shared/src/ai/*`. Rules: `.claude/rules/api.md`
§ AI services.

- **One resolver (D17)**: `resolveChat` / `resolveEmbeddings` are the only readers of `ai_configs`
  / `agent_models` and the only place credentials are decrypted. Chat order: per-agent assignment →
  tenant default → platform `ANTHROPIC_API_KEY` → **Workers AI `glm-4.7-flash` via `[ai]`** → 503
  `ai_not_configured`. Embeddings order: tenant → Workers AI `bge-m3` (1024-dim) →
  `EMBEDDINGS_API_KEY` → 503. Rerank order (`resolveRerank`, never a 503): tenant `rerank` row
  (a Cohere-style `/rerank` as `openai_compatible`, or `workers_ai`) → Workers AI
  `bge-reranker-base` via `[ai]` → none (search keeps its fused order). Workers AI calls are **billed** to the account; removing `[ai]` from
  both tomls makes the kit zero-spend. Credentials never leave the server (`hasCredential`), and a
  stored key stays with the provider and normalised base URL it was entered for: changing either
  needs the key again. A save decides that on the row it overwrites, read `FOR UPDATE` inside its
  transaction, so of two concurrent saves the second decides on what the first wrote; every
  error is normalised to `AiError` with secrets redacted.
- **Providers**: `anthropic`, `anthropic_compatible`, `openai`, `openai_compatible`, `workers_ai`.
  There is no Vercel AI SDK and no Bedrock (a SigV4 adapter behind `ChatClient` is the extension).
  Workers AI quirks — two response shapes, per-model `tool_choice`/streaming lists, fragmentary tool
  calls, GLM's own `<tool_call>…<arg_key>` markup passed through unparsed, schema-flattening retry —
  are in `services/ai/CLAUDE.md`. The floor model was chosen
  because it can run the *agents*. Defaults: `claude-haiku-5-5`, `gpt-6-luna`.
- **The request body is per MODEL, not per provider** (`shared/src/ai/models.ts`). Claude 4.5 and
  earlier take a thinking budget. 4.6+ take `adaptive`. "Off" is `disabled`, Sonnet 5.5's
  `between_tools`, or no field on models that always think (Opus 5.5, Fable). The Claude API takes
  no `temperature` (API version `2026-10-21`); an `anthropic_compatible` vendor still gets it.
  Opus/Sonnet 5.5 and Fable 5.1 refuse a forced tool, so a forced tool becomes a prompt instruction.
  First-party `openai` speaks the **Responses API** (`store: false`), because
  Chat Completions cannot call tools on GPT-6 Astra/6.1 Sol, nor on Luna while it reasons.
  Thinking off there means the lowest `reasoning.effort` the model takes. `openai_compatible` stays
  on Chat Completions. Reasoning (Claude thinking blocks, OpenAI reasoning items) rides a tool loop
  as opaque `reasoning` blocks, returned unmodified to the provider that produced it. It is kept
  in checkpoints and never in chat history. Each adapter recovers ONCE from a refusal the traits
  misjudged (thinking, sampling, forced tool, effort, a replayed block's signature) and remembers
  it. So an unknown id costs one call, and it is read as the newest generation.
- **Kit** (`services/ai/agent-loop.ts`): `runStreamingChat`, `runToolLoop`, `callStructuredTool`, prompt
  caching helpers. Prompts are code (`PROMPT_REGISTRY`) with per-tenant override rows.
- **AG-UI is the wire protocol (D28)**: `@ag-ui/core` is pinned exactly and imported only by
  `shared/src/ai/agui.ts`. The kit emits 15 events plus a `kit.` CUSTOM namespace (apps use their
  own prefix). It supports SSE (`data:` only, no `event:` line) or protobuf.
  `POST /api/agui/run` is the `RunAgentInput` endpoint. The server owns the transcript, the client
  supplies only the new message, and client `tools[]` are refused.
- **Chat**: owned by `userId`; `chat-turn.ts` is the one implementation behind `/api/chat` and
  `/api/agui`. Everything that can fail as JSON runs before the stream opens, and stream writes use
  `streamDatabase(c)`. A cancelled run emits no terminal event. Chat can call the knowledge
  tools (`CHAT_KNOWLEDGE_TOOLS`), capped at 6 turns. **One tool list, filtered per surface**:
  `buildAgentTools(ctx)` builds every tool (the knowledge tools, then each plugin's `tools`), and
  chat, agent runs and the MCP server each ask `toolsFor('chat' | 'agents' | 'mcp', ctx)`
  (`services/agents/tools/surfaces.ts`). A tool names its surfaces (`Tool.surfaces`, absent =
  all); on `mcp` a terminal tool or one with an approval gate is never offered, and
  `mcpToolProfile(tool)` derives the scope a call needs (`mcp:read`, or `mcp:write` for
  `sideEffects`) and the annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint` from
  `sideEffects` and `durable`, `openWorldHint` false), each overridable in `Tool.mcp`. **Long threads are compacted**: a
  character-budget window (`CHAT_HISTORY_MAX_CHARS`), with the dropped prefix folded into
  `conversations.summary` by the `chat.compact` job (compare-and-set). Document cards come from
  `kit.document` events produced by a pure mapper, so nothing about a card is stored. The admin
  inspector (`/stats`) is derived per request.
- **A plugin's chat turn**: `streamChat` (`plugins/api/chat.ts`, §16) streams a conversation the
  PLUGIN owns — no `conversations` row, no compaction, only the plugin's tools — over the same
  pieces as chat: `resolveChat` (its `promptKey` may carry an `agent_models` assignment),
  `runStreamingChat`, `aguiTextSegmenter` + `aguiToolEvents` (the tool half, shared with
  `chat-turn.ts`), `withAgentTrace`, and `recordUsage` under the plugin's `feature`. Its CUSTOM
  events are `<plugin id>.…`, checked at emit time. Tests script the platform model with
  `scriptPlatformChat` (the `AI` binding stub) rather than mocking the resolver.
- **Agents (D7)**: `POST /api/agents/runs` enqueues (row → Workflow instance → 202); the exclusive
  index dedupes, per (tenant, agent, `agent_runs.concurrency_key`) — the SLOT a run holds: `''`
  for an exclusive agent (one per tenant), a caller's `enqueueRun({ concurrencyKey })` to narrow it
  to one active run per key, NULL for an agent declaring `exclusive: false`, whose rows sit outside
  the index so any number may be active at once — one person's conversation with an agent, which
  parks on their answers while others hold conversations of their own. A caller who finds the slot
  held gets that run back (202, `deduplicated`) only if they may see it; otherwise a bare 409
  `agent_run_active`, under `?strict=1` too. `enqueueRun({
  idempotencyKey })` goes further — at most one run EVER per (tenant, agent, key): the run id is
  derived from the three (`idempotentRunId`, a SHA-256-shaped v8 UUID), so the primary key is the
  gate and a repeat answers the first run, settled or not; a failed `create()` deletes the row
  rather than failing it, so the retry can start it. A plugin starts a run from a job, cron, email
  or public handler with `ctx.startAgentRun` (§16), the same `enqueueRun`. A plugin agent
  reaches `ctx.interrupt`, the resolved `chatModel` and `storage()` through `AgentCtx` (`@/plugins/api`). The Workflow runs `claim → execute#N → (resume#N | expire#N) → finish`, and
  **every step name carries its round**, because a repeated name replays the recorded result.
  That body is `runAgentRun` (`workflows/agent-run-body.ts`), written against the neutral `Step`
  in `src/platform/types.ts` — the run-engine seam shared with Rocketpod, whose OpenWorkflow
  adapter drives the same body; `AgentRunWorkflow` is the Cloudflare adapter. A retry resumes:
  `ctx.checkpoint` keeps the tool-loop transcript and `ctx.once(key, fn)` gives once-per-run
  effects (a DB unique index; at-least-once with a recorded result).
- **Durable loop (D44)**: `runToolLoop({ journal: ctx.journal })` records every model turn and
  every tool result in `agent_run_turns` AS IT SETTLES, and checkpoints the assistant turn BEFORE
  its tools run. A retry — the 10-minute step timeout, an evicted isolate, a database blip — is
  served what was recorded: a model turn asked about the same transcript (`request_hash`) is not
  billed again, a tool call with a settled result (keyed by its `toolCallId`) is not run again,
  even part-way through a turn, and steering notes folded into a recorded turn are re-applied
  rather than re-asked. A transcript that changed underneath a record (an unrecorded read re-ran
  and answered differently) asks the model and replaces the record. An unrecorded read simply
  runs again; a tool marked `Tool.sideEffects` writes `started` first, and a retry that finds
  `started` with no result settles it as an **unknown outcome** the model sees
  (`UNKNOWN_OUTCOME_RESULT`) — unless the tool is also `durable`, which re-runs it with
  `call.idempotencyKey` (the `toolCallId`) for the system it writes to. The policy's salvage call
  is journaled too (turn 0). A loop inside a `ctx.scope`/`ctx.map` item has its own journal
  (`items[2]/tool-loop`), so it resumes from the record although scopes have no checkpoint; a
  plugin's `ctx.toolLoop` binds the journal for it. The journal outlives the settle (the
  checkpoint does not) for `AGENT_TRANSCRIPT_RETENTION_DAYS` (default 30, nightly
  `pruneAgentTurns`), which is what makes a tool-loop run strictly replayable. **Cancel reaches
  the call in flight**: each `execute` attempt polls its row every 3 s (`watchCancel`,
  `services/agents/cancel.ts`) and aborts `ctx.signal` on a cancel; every call through
  `ctx.chat.client` (and `decide`'s client) carries the signal and is RACED against it, so even a
  provider that ignores it (Workers AI) stops being waited for, and an aborted attempt settles
  `cancelled`, never as a retryable `unavailable`. Pass `ctx.signal` to `runToolLoop` and your own
  `fetch`es; a plugin's `ctx.toolLoop` / `ctx.structured` pass it already. A settled cancel
  projects as AG-UI's `RUN_FINISHED { outcome: { type: 'cancelled' } }`, not a `RUN_ERROR`. A
  cancel of a `running` run silent for longer than a step can run (`ATTEMPT_DEAD_MS`, 12 min — its
  attempt died with its isolate) settles at once; and a run settled OUTSIDE its attempt (cancel,
  force, the sweeper, a read reconciling) still ends its log with a `status` event carrying a
  `reason`, so the timeline — which shows a settled run's unclosed work as stopped — tells the end.
  **Tracing a run**: the first claim exports a zero-length `run started` span under the run's root
  id (`rocketflare.run.pending`, the trace's name and tags), so a backend lists the run while it
  is still going; the root `invoke_agent <key>` is still recorded once, at `finish` — an OTLP span
  cannot be updated, and a backend that keeps the first copy of an id would keep the unfinished
  one. Every span of a run carries `gen_ai.conversation.id` = the run id (AG-UI's `threadId`);
  the `ai_spans.conversation_id` column stays a chat thread's. **Keys**: tool
  calls are keyed by the model's `toolCallId`, never an author key; a loop's own key is
  `RunToolLoopOptions.key` (default `tool-loop`); `ctx.once(label, fn, { inputs })` keys on the
  label plus a hash of `inputs` (`label#<12 hex>`), so `for (q of queries) ctx.once('search', fn,
  { inputs: q })` is one record per query; and any key used twice in ONE attempt — two `once`
  calls, or two loops — throws `EffectKeyConflictError` (event code `agent_effect_key_conflict`,
  never retried). Order-derived keys were rejected: Workflows cannot pin an instance to the code
  it started on, so a run parked across a deploy would replay new code against old positions; data
  keys survive that. Why: the durable-agents review (`docs/research/durable-agents-review-2026-11.md`
  in the kit) — a mid-turn crash re-billed the turn and re-ran every tool that had finished.
- **Versions, children, inspector (D44 phase 3)**: **version pinning** — every run records the
  agent's `meta.version` (`agent_runs.agent_version`, default 1) and the Worker deployment it last
  ran on (`worker_version_id`, from the `[version_metadata]` binding `CF_VERSION_METADATA`). An
  attempt that finds a different `meta.version` applies `meta.onVersionChange`: `continue` (the
  default — sound because every key is data-derived; a `status` event `reason: 'version_changed'`
  says so), `fail` (code `agent_version_changed`), or `rerun` (cancel, then a NEW run of the same
  input, idempotency key `rerun:<runId>` — the old run's record is the audit trail). `pinned: true`
  forces `fail` and is the one place order-derived keys are allowed: a repeated `ctx.once` label
  becomes `label@2`, `label@3` instead of a conflict. **Bump `meta.version` when a change moves or
  renames a top-level `once`/`decide` key or changes what a decision is about**; the recordings
  check (`apps/web/tests/agent-recordings/*.json`, written by `agent:replay --record <dir>`)
  replays each committed run on every gate and fails with "bump `meta.version`" when such a change
  arrives at the same version. **HITL**: `meta.hitl = { timeout, remindAfter, onTimeout }` — an
  ask's deadline is `timeout` capped at `AGENT_INTERRUPT_TIMEOUT`; the `*/10` cron's
  `sendReminders` reminds ONCE at `remindAfter`; `onTimeout: 'reject'` answers an expired ask as a
  rejection by nobody (`cancelled`, note `Nobody answered before the deadline`) and wakes the run,
  where the default `expire` cancels it. An ask may name `assignees: { userIds, groupIds }`
  (visibility groups): they are the ones notified, see it in their inbox, may read the run and
  answer — the requester then may not; an owner/admin always may. **Child runs**: `ctx.spawn(key,
  agentKey, input)` starts another agent as its own run (`parent_run_id`, id from
  `spawn:<parent>:<key>`, so a retried parent finds the same child), parks the parent with NO ask
  while it runs, and the child's `finish` (or a cancel of it) wakes the parent, which gets the
  output (recorded as effect `spawn:<key>`, what replay serves) or `ChildRunFailedError`. The
  child's budget is what the parent could still spend (`agent_runs.budget`), and the parent's meter
  counts every descendant's spend; a cancel cascades down; a parent that ends unsuccessfully
  cancels its active children. Children are left out of `GET /runs` unless `?parentRunId=` and
  carry `rocketflare.parent_run_id`/`parent_trace_id` on their spans. **Inspector**: `GET
  /api/agents/runs/:id/timeline` (`@rocketflare/shared/ai/agent-timeline`) merges events, turns,
  tool calls, effects, decisions, asks and children by time, with versions and spend vs budget —
  `rocketflare agents inspect <runId>` and the run page's admin **Inspect** tab read it; `runs list`
  gains `--parent`, `--since`, `--agent-version`. The agents UI scales by agent: `/agents` is one row
  per agent (last run, 30-day runs/tokens/avg time/cost from ONE `GET /api/agents/stats`, scoped like
  the runs list), each agent has `/agents/:agentKey` (metrics + its runs), and `/agents/runs` lists
  every run. Why: the durable-agents review's phase 3 (#156).
- **Human-in-the-loop (#17)**: `ctx.interrupt({ key, spec })` parks the run on
  `step.waitForEvent`. The key must be stable across attempts. Answering is a compare-and-set on the
  row, *then* a nudge to the instance (`not_found` → restart as `<runId>-rN`). There are four
  closed interrupt kinds (approval/choice/input/form). Model-called tools are gated on the tool
  (`requiresApproval`) before any handler runs, and an approval runs only the call the person was
  shown: that tool, those arguments (or their edit), once. Chat cannot park a turn, so
  `runStreamingChat` neither offers nor runs a tool that declares a gate. Artifacts are an upserted
  table, and steering notes are event rows delivered once.
- **Decisions (D37)**: `ctx.decide(key, { state, questions })` asks typed questions — `noul`
  (yes/no), `choice`, `score`, in TypeSafe's own vocabulary — and gets back an answer, a
  distribution and a `confidence` per question; `ctx.decide.sift` asks the same yes/no of every item
  in ONE request, `ctx.decide.pick` chooses one item or none. **A question decides what a thing IS;
  the agent's code decides what follows**, so a threshold is a number in code, not a prompt. Engine
  order (`resolveDecisions`, the one resolver): tenant `ai_configs(scope='decisions')` (provider
  `typesafe` — Jev, Settings → AI like any provider, with the same Test button) → platform
  `TYPESAFE_API_KEY` → the chat model on prompt key `agent-decide`, which reports its own
  probabilities and is recorded `method: 'llm_self_report'` (uncalibrated, labelled as such in the
  UI) → 503. Every call is one `agent_run_decisions` row, once per `(run, key)` like `ctx.once`: a
  re-entered `run()` replays the recorded answer, and the same key with different questions fails
  the run (`questions_hash` — the policy fingerprint, over the questions and not the state). Each
  call also writes `ai_usage` (`agent:<key>:decide`), a `decide <key>` span, and a thin `decision`
  event projected as `kit.agent.decision`; `GET /runs/:id` returns `decisions[]`. `triage-research`
  is the worked example (screen → triage → answer / not covered / escalate to `research-topic`), and
  evals score decisions per question with `DecisionJudge` (`expected.decisions`, accuracy + Brier)
  without a model call. Why: AgentRun-style decomposition — cheap, recorded, separately testable
  judgments instead of a model turn per decision.
- **Replay (D38)**: `pnpm web agent:replay <agent> --tenant <slug>` runs the agent's CURRENT code
  over its settled runs and reports what would change — the change you are about to make, checked
  against a thousand past cases in minutes, not against production. The replay context answers from
  the record: `decide` from `agent_run_decisions` (same questions about the same state → `served`;
  reworded → `drift`; same questions about a different state, because upstream code changed what the
  decision is about → `stale`), `once` from `agent_run_effects`, `interrupt` from
  `agent_run_interrupts`, a tool loop's turns and tool results from its journal (`agent_run_turns`,
  D44 — same transcript and system prompt → `served`; changed → served and flagged `drift` in
  strict, asked again in live); anything the record cannot answer is a MISS (`strict`, the default — no
  model call at all) or asked for real (`--live`, which also re-runs a `ctx.once(key, fn, { replay:
  'rerun' })` — a pure model call whose prompt may have changed). `--live` reads the tenant's
  knowledge base, prompts and model choice as they are TODAY, through the Worker's own resolver —
  the tenant's configs first, then the Workers AI binding, borrowed through wrangler's
  `getPlatformProxy` — and warns before starting when knowledge search would be degraded (no
  provider, or a key where the Worker uses Workers AI: the dense leg reads only chunks of the
  query vector's model, so another tier quietly degrades to keyword search). Each run replays in a READ ONLY
  transaction and `ctx.db` refuses writes before they are sent (listed, not fatal). Per run: a
  verdict (`match` / `differs` / `incomplete`), the output diff by JSON path, each decision's
  status, each loop turn's (`turns`), and `orderDrift` when today's code asks its top-level `once`
  / `decide` keys in a different order from the run (a moved step — what a run parked across that
  deploy would feel); a drifted turn or a moved key makes the verdict `differs`; exit 1 unless
  every run matches. `--candidate <file>` replays another definition with the
  same key — how a compiled variant is proven against the full agent's history. Local script only:
  no route, no UI. Why: D37 made the judgments recorded; replay makes the CODE around them testable.
- **Volume (D39)**: exclusivity is the `concurrency_key` slot above (PR #77), so a non-exclusive
  agent (`triage-research`) runs any number at once. Two tenant-wide gates sit on
  every enqueue: `AGENT_MAX_ACTIVE_RUNS_PER_TENANT` (default 50, 429 `agent_runs_limit` — a soft
  cap, counted then inserted) and `AGENT_TENANT_DAILY_COST_USD` (429 `ai_budget_exceeded`),
  after the tenant itself — a suspended one is 403 `tenant_suspended` (§1).
  `POST /api/agents/runs/batch` takes up to 100 inputs of one non-exclusive agent (400
  `agent_exclusive` otherwise), validates each, inserts them under one `batch_id` and makes ONE
  `createBatch()` call; that call is all or nothing, so on failure each instance is created alone
  and only the rows that really cannot start are failed (`GET /runs?batchId=`, `rocketflare agents
  run <key> --batch x.jsonl`). Inside a run, `ctx.scope(prefix)` namespaces every keyed primitive
  (`once`, `decide`, `interrupt`, `artifact`, `step` → `prefix/key`; no checkpoint) and
  `ctx.map(key, items, fn, { concurrency, keyOf })` runs each item as a `once` in its own scope, at
  most `min(concurrency ?? 4, 6)` at a time: a retry replays the items that finished, the first
  error stops scheduling, and asks from several items become ONE park. No parent/child runs. Every
  call through `ctx.chat.client` and `ctx.decide` is metered — one `ai_usage` row carrying
  `agent_run_id`, awaited as the call returns, so a run cancelled or failed mid-loop has a row for
  every turn it paid for (issue #2) — and an agent writes no ledger rows (`ctx.recordUsage` for a
  client of its own); `GET /runs/:id` returns `usage`. The meter checks the run's budget before each call
  (`meta.budget` over `AGENT_RUN_MAX_TOKENS` / `AGENT_RUN_MAX_COST_USD`, plus the tenant's daily
  cap; tokens include prompt-cache reads and writes), starting from every earlier attempt's rows; over → `failed`, event code
  `agent_budget_exceeded`, never retried. Why: "thousands of cases a day" needs many runs, cheap
  fan-out inside one, and a ledger that can say what each run cost.
- **Policy (D39, issue #1)**: `meta.policy { maxTurns, maxToolCalls, maxConcurrentToolCalls,
  maxDurationSeconds, repeatedFailureLimit, onExhaustion }`, passed to `runToolLoop` as `policy`, is
  how far one run's loop may go; `AGENT_MAX_TURNS` stays the ceiling. Tool calls execute concurrently
  up to `maxConcurrentToolCalls` (default 4; cap 1 is sequential) even with no policy configured; the
  remaining limits are opt-in. Every limit counts across attempts — turns and ACTIVE time ride the
  checkpoint (time parked on a person is not counted), tool calls and the failure streak are read
  back out of the transcript — and every call in the turn that crosses a budget still gets a result,
  because the next request must not carry an unanswered `tool_use`. Running out is behaviour the loop
  owns: `'final-answer'` (the default) makes ONE forced call to the loop's single terminal tool over
  the transcript (`salvaged: true`; what `research-topic` used to do by hand), and a salvage that
  fails fails the run; `'fail'` throws `ToolLoopExhaustedError` → `failed`, event code
  `agent_policy_exhausted`, never retried. **`authorizeTool(call)`** on the same loop is the
  deny-by-rule half of #3 (`requiresApproval` is the ask-a-person half, #17): a refused call is never
  gated, never run, and the model is told why.
- **Reading runs**: `agent_run_events` is the durable log, and AG-UI is a pure read-time
  projection (`/agui`), also streamed live by tailing `seq` (`/agui/stream`, #7). A read-stream
  failure emits no `RUN_ERROR` (clients reconnect); `id:` goes on the last frame of a row's group,
  and reconciliation runs once before the first frame. Payloads never go over the tenant-wide DO,
  because run visibility is per run.
- **Knowledge (D18)**: `documents` + `chunks` (pgvector HNSW). Text is ingested inline or by job;
  uploads go to R2, then `AI.toMarkdown`, then the same indexer. Every text write strips NUL and
  the other C0 controls except tab / LF / CR (`stripControlChars`, `api/utils/core/text.ts`) —
  some PDFs convert with NULs, which Postgres refuses (22021); the span store does the same over
  `ai_spans` (jsonb refuses `\u0000`, 22P05); line endings are normalised to LF before the text
  is stored. **Chunks are structure-aware** (`chunking.ts`, 800/100-token windows): each is an
  exact slice of `documents.content` at `[char_start, char_end)` — the overlap comes from starting
  the next window earlier, never from carried text — every chunk begins and ends at a markdown
  heading: consecutive whole sections that fit a window share one chunk, only a longer section is
  cut inside, and each chunk stores the headings its sections share as `heading_path`
  (`Pricing › Annual plans`); on the Brightside corpus this keeps 54 chunks where one chunk per
  section made 343 fragments, and recall@10 fell with them; a GFM table (how `toMarkdown`
  renders a spreadsheet sheet) splits only between rows, and a chunk holding rows without the
  header stores it as `table_header` — the whole header when it fits a quarter of the window,
  else the header row's first columns and ` …`, so header plus rows always fit one window and a
  wide header is never repeated whole on every chunk. Heading path and table header are prefixed
  to the text that is EMBEDDED and indexed, never to the stored chunk, and that prefix is cut to
  `EMBEDDING_CONTEXT_MAX_CHARS` (a heading title to `HEADING_TITLE_MAX_CHARS` in the path), so
  stored and embedded text grow with the document. Headings and table delimiter rows are found
  by a linear scan of each line, never a backtracking regex. `page` is always null (see gaps).
  Search is hybrid dense + lexical (the lexical half matches ANY query word against
  `chunks.search_vector` — a GENERATED tsvector over heading path + table header + text with a GIN
  index, in `SEARCH_TEXT_CONFIG` — ranked by `ts_rank_cd`; `anyTermTsquery`, so a sentence's filler
  words cannot veto it) with RRF, scoped by `AccessScope` (§1). **Each dense leg reads only chunks
  whose `embedding_model` is the query vector's model** (migration `0027` backfilled it from the
  document), so a document embedded by another model stays findable by keyword alone. A hit
  carries `headingPath`, `page` and `charOffset` (the stored `char_start`; `position()` of the text
  for a chunk written before 0.37.0). **Filters**: `POST /search` takes `filters`
  (`searchFiltersSchema`: `sources`, `contentTypes`, `createdFrom` / `createdTo` as inclusive UTC
  days) — one predicate over `documents` (`documentFilterPredicate`) ANDed with the tenant and
  visibility predicates, so a filter only ever removes hits. `GET /api/ai/documents/facets` lists the
  sources and content types (with counts) and the date span of the indexed documents the reader
  may see, which is what the Search page's filter column offers; the page keeps every filter in the
  URL (`?source=&type=&from=&to=&documentId=`). The facets also carry `staleEmbeddings` — the
  reader's visible documents embedded by another model than today's, i.e. invisible to the dense
  leg — and the page shows a notice with "Re-index now" (`POST /reembed`) for `manage Document`,
  polling the facets until it reaches 0 (`/health` is admin-only, so the count comes from here).
  The response's `lexical` is `no_terms` when Postgres leaves no lexeme after stopwording
  (`numnode(to_tsquery(…)) = 0`, run beside the legs — `anyTermTsquery` keeps every word, so the
  stopword decision is Postgres's), and an empty answer then says the word is too common rather
  than "no matches". **Reranking** (`services/ai/rerank.ts`, the `RerankFn` seam
  — `(query, documents) => scores` in [0, 1]): the top `RERANK_CANDIDATES` (default 20) fused candidates go to the resolved
  reranker with their title and section in front, are reordered by its score (`rerankScore` on the
  hit; `rank` is the final order, `score` stays the RRF score), filtered by `RERANK_MIN_SCORE` when
  set (unset = off), then cut to `limit`. The Cohere-style client reads its request dialect
  (Cohere, Voyage, Fireworks) from the base URL's host; Workers AI's logits are sigmoided onto the
  same scale. No reranker, fewer than two candidates, `rerank: false` (internal callers only), a
  failure or a 3 s timeout answer the fused order, and the `retrieval` span says which
  (`rocketflare.rerank.*`) with a `rerank <model>` child. On the kit fixture a Fireworks
  `qwen3-reranker-8b` lifts MRR from 0.66 to 0.84 and recall@5 from 0.87 to 1.00 at a median
  465 ms per search over 20 candidates; 50 candidates scored the same at 810 ms, because every
  answer passage was already in the fused top 20, hence the default (`docs/EVALS.md`). **Metering**: every embedding (index, re-embed, query) and
  rerank call is an `ai_usage` row, `knowledge.embeddings` / `knowledge.rerank`, and every fact
  extraction call a `knowledge.extraction` row, with the provider's token count or a 4-chars
  estimate; a ledger failure is logged and never fails an ingest or a search (the search route
  writes it in `waitUntil`). `KNOWLEDGE_TENANT_DAILY_COST_USD` (unset = no cap) bounds the three
  per UTC day through `knowledgeExtractionAllowed`, which only extraction consults: indexing and
  search never pause. **Content hash**: `documents.content_hash` is sha-256 of the
  normalised text (CRLF → LF, trimmed). A plain ingest — or a text upload — whose hash matches a
  non-failed document of the same tenant and `source` answers THAT document (`200`,
  `deduplicated: true`, nothing stored), only when both are tenant-wide so a dedupe never reveals a
  restricted document.
  **Upkeep** (`services/ai/reindex.ts`): a document is **stale** when it is `indexed`, has text, and
  holds a chunk whose `embedding_model` is not (or is null against) the model `resolveEmbeddings`
  picks for the tenant today; `GET /api/ai/documents/health` (admin+) counts documents by status
  plus `staleEmbeddings` (documents) and `staleChunks`. The `document.reembed` job rebuilds them
  through `indexDocument` in bounded batches (≤ 20 documents / 400 chunks per message,
  re-enqueued while more remain), vectors first so a failure keeps the old chunks searchable; it
  runs from `POST /api/ai/documents/reembed` (admin+, 202) and automatically after an
  `ai_configs` save or delete that changes the resolved embeddings model (after the commit; without
  `JOBS_QUEUE` the save still succeeds and the health count shows what is owed). The message names
  its model, and one for a model the tenant no longer resolves is acked, so chains do not pile up;
  there is no claim row. `POST /api/ai/documents/:id/retry` (owner or `manage Document`) puts a
  `failed` document back on `document.convert` (no text) or `document.index` (202; `409
  document_not_failed` otherwise), and the Documents page offers it as Retry. Inline indexing is
  an `ingest document` span — under the active span, else a root on the request tracer — with
  its embeddings batches nested.
  `document-content.ts` is the one text reader behind both
  the viewer and `get_document`. Agent tools resolve the requester's access at execute time.
  **External ids (D34)**: `documents.external_id` is unique per `(tenant_id, source)` (partial
  index, `0016`); an ingest carrying one is an upsert — one `ON CONFLICT` statement, grants
  replaced, chunks rebuilt (the old chunks go in the upsert's transaction, so a pending or failed
  re-index never serves the replaced text), a replaced original removed from R2 — so a connector's re-sync never
  duplicates. An upsert whose hash matches an `indexed` row whose chunks are all of today's model
  is `mode: 'unchanged'`: no chunking, no embedding, chunks kept; title, owner, visibility and
  grants still follow the source. Plugins reach it through `ingestDocument` (§16).
  **Platform documents**: a `documents` / `chunks` row with `tenant_id` NULL is knowledge about the
  APP itself (a plugin's user guide), readable by EVERY tenant by design. RLS pairs
  `tenantIsolation()` with a SELECT-only `platformReadable()` policy (`tenant_id IS NULL`), so a
  scoped connection reads platform rows and can never insert, update or delete one; they are
  written only on the owner connection by `ingestPlatformDocument` from a job or cron (§16). A CHECK
  requires `source` + `externalId`, unique among platform rows. They are always embedded, by
  `resolvePlatformEmbeddings(cfg, env)` (`EMBEDDINGS_API_KEY`, else Workers AI via `[ai]`, else
  none, and then nothing is written), so every tenant's query meets vectors of one model.
  `searchChunks` reaches them only when a caller names their sources (`platformSources`, never
  from a request body). The query is embedded once per model when the tenant's embedder differs,
  with one dense leg per corpus fused by the same RRF, and the answer reports `semantic: 'used' |
  'unavailable'`. Every tenant document view (the list, viewer, `/search`, `get_document`,
  `list_documents`, delete) keeps `tenant_id = $t` and never shows one; `search_knowledge` includes
  them for the sources `ServerPlugin.knowledgeSources` names, marked `platform`, and chat and agent runs show no document card for one (the documents page cannot open it).
- **Knowledge facts (D43)**: typed facts read from documents and attached to the app's own rows,
  or to a staging entity until one exists, each with its source span, trust, validity and state,
  so people and agents are told when a fact is unconfirmed or contradicted. **Off by default**:
  the core flag `knowledge-facts` (per tenant, Admin → Feature flags) AND at least one registered
  entity type switch it on; without both nothing is extracted, `/api/knowledge` is a 404 and the
  UI shows none of it. Why it is built this way: a fact never writes a domain column (a person
  promotes or applies it), an uncertain match becomes a staging entity with a "same as …?" item
  rather than an automatic link (attaching a fact to the wrong customer is the worst failure), and
  review never blocks retrieval (an open fact is used and labelled). **Contracts** (`shared/src/ai/knowledge-facts.ts`): an entity type declares `type`,
  `label` and `facts`, a zod object whose keys are snake_case fact keys and whose values are the
  value schemas (`.describe()` steers extraction; the object must render through
  `z.toJSONSchema`, so a date is `z.iso.date()`); `FACT_STATES` `accepted · unconfirmed ·
  conflicting · superseded · rejected` (the middle two are open review items, used AND labelled —
  review never blocks retrieval); `SOURCE_TRUST` `person > upload > agent > integration`
  (`trustRank`), which only decides which side of a conflict an answer leads with — both are
  kept and cited; the fact, entity-card, review-action, possible-match and `factHitSchema` shapes.
  **Tables** (migration `0028`, which with `scripts/migrate.ts` creates `pg_trgm`):
  `knowledge_entities` — staging entities (`type`, `name`, `aliases text[]`, `promoted_type` /
  `promoted_id`, `merged_into`, an embedding of name + aliases, `possible_matches` jsonb = an open
  "same as …?" item and its `reviewer_user_id`), a GIN trigram index on `name` and a
  `(tenant_id, type, lower(name))` lookup; `knowledge_facts` — identity (`entity_kind`
  `domain|staging`, `entity_type`, `entity_id` text, no FK), content (`key`, `value` jsonb,
  `value_text`), source (`document_id` **cascade** — deleting a document removes its facts, and
  the delete — `DELETE /api/ai/documents/:id` or a connector's `deleteExternalDocument` — first
  runs the same repair as re-extraction, in one transaction (`deleteDocumentsWithFacts`, `knowledge/remove.ts`), so a
  fact one of them superseded or conflicted with alone is current again;
  `chunk_id` **set null** — a re-index replaces chunks and the fact keeps its span and quote),
  trust (`source_kind`, `confidence` 0..1), state (`state`, `superseded_by_id`, `conflicts_with
  uuid[]`), time (`valid_from`/`valid_to`, `observed_at`, `confirmed_by`/`confirmed_at`) and access
  (`reviewer_user_id`, `visibility` `tenant|groups`, `private` reserved and never written). A fact
  has no grants of its own: it is read through its document's (`document_id` →
  `visibleDocuments`). Deleting the last fact about a staging entity leaves the entity.
  **Registry** (`api/services/knowledge/`): an `EntityTypeRegistration` (`types.ts`) is the
  declaration plus an optional `table` (none = the type lives only as staging entities),
  `idColumn` (default `id`), `labelColumn`, `aliasColumns` (`text` or `text[]`) — drizzle column
  OBJECTS of that table, never strings — and an optional `resolve(name, { db, access, limit })`
  returning `{ id, label, score }` candidates in the reader's tenant. Without one, a type with a
  table gets `defaultEntityResolver`: trigram `similarity()` of the mention against label and
  aliases, `tenant_id = access.tenantId`, at least `DEFAULT_RESOLVE_MIN_SCORE` (0.3). The app's
  types are `APP_ENTITY_TYPES` in `entity-types.ts` (app-owned, `manual`; EMPTY in the kit — the
  core registers no domain types), a plugin's are `ServerPlugin.knowledgeEntityTypes` (§16), and
  `knowledgeEntityTypes()` composes them, throwing on a plugin type outside `<plugin id>.`, an app
  type with a dot, a duplicate, a non-snake_case key, an unrenderable facts object, or a column
  that is not its table's. The reference plugin registers `example-feature.note`.
  **Extraction** (`api/services/knowledge/extract.ts`, the `knowledge.extract` job): behind the core
  flag `knowledge-facts` (default OFF, per tenant) and only once a type is registered — both checked
  when `afterTextIndexed` enqueues it (only for a text that CHANGED: never the unchanged upsert or a
  dedupe) and again in the job. A document is read in heading-bounded sections rebuilt from its
  stored chunks (≤ 12,000 characters, one chunk never split); each section is ONE forced
  `submit_facts` call (`callStructuredTool`) carrying the types with each key's JSON schema and
  `.describe()`, the document's title and date, the known entities the section names (with their
  accepted facts) and the other known names. That material — and the facts a decision model is
  shown below — is built only from TENANT-VISIBLE documents, whatever the visibility of the one
  being read: everyone who may open the document may open those, so a value or a name from a
  group-restricted document never reaches the prompt and cannot be copied into a document with a
  wider audience (a group-restricted document's own earlier facts are not shown either; states
  are still decided against every fact the tenant holds, and readers mask what they cannot see).
  **Model**: `resolveChat` under prompt key
  `knowledge-extract`, so Settings → agent models can point it at a cheaper model — not TypeSafe's
  Jev (D37), whose typed questions answer one choice, score or yes/no, not a list of facts with
  quotes. **The model proposes, code decides**: a candidate survives only if its quote occurs
  verbatim (whitespace, quote marks and emphasis forgiven) in the section — stored as `chunk_id`,
  absolute `char_start`/`char_end` and the quote — its value parses against the key's schema
  (`values.ts`: "£1,140" → 1140, "yes" → true, a case-blind enum), and every date resolves in CODE
  against `documents.created_at` (`dates.ts`: ISO, UK numeric day-first, "next Monday", "the first
  of next month", "start of next quarter", "until 10 July"…); anything unreadable drops the fact,
  and so does a value, its wording or a date longer than 2,000 characters, before anything parses
  it.
  **Trust** (`source_kind`): `integration` for a plugin's `ingestDocument` (`documents.origin`),
  `agent` for an `agent:` source, else `upload`; the reviewer is the ingest's `reviewerUserId`
  (`documents.reviewer_user_id`), else the document's owner, else none. **Resolution**
  (`entities.ts`): the type's resolver (domain rows), then staging entities by trigram over name and
  aliases (`LINK_THRESHOLD` 0.6 links one clear candidate; 0.45–0.6, or a tie, is a possible match
  on a NEW staging entity with a reviewer), then — only when nothing linked — the name's embedding
  (cosine ≥ 0.9 adds a review candidate, never a link), else a new staging entity. Only a
  tenant-visible document adds names to an entity (aliases of the one it links to, or of the one it
  creates): an entity is shared by every document naming it and its aliases are shown and searched
  wherever it is visible. The thresholds
  come from the fixture: "Harbour View Dental" / "…Practice Ltd" 0.61, "Riverside Lodge" / "…Care
  Home" 0.62 must link; "Harbourside Dental Lab" / "Harbour View Dental" 0.48 and "Northgate Vets" /
  "…Veterinary Surgery" 0.43 must not. **State** (`state.ts`) against the answerable facts held
  for that entity and key: none → `accepted`, or `unconfirmed` below 0.7 confidence; the same value
  → `accepted`, and a held `unconfirmed` one is confirmed; a different value → both `conflicting`,
  linked both ways (`conflicts_with`); when both sides carry an explicit validity window and the
  windows do not overlap it is a change over time instead — the earlier is `superseded` by the
  later. **Preference is derived, never stored** (`isPreferredOver` / `preferredFact` in shared):
  an answer leads with the newer side when its source is at least as trusted, else the older.
  **A section never contradicts itself**: two values for one entity and key over the same
  validity in ONE section are a misreading (a table's two price columns put on one entity) and
  neither is written (`dropped.ambiguous`); different windows there are a change over time and both
  stay. A placeholder value (`<UNKNOWN>`, `N/A`, `TBD`) is no value.
  **Where text comparison would be guessing, a decision model is asked** (`judge.ts`, typed
  `choice` questions through `resolveDecisions` — TypeSafe's Jev when configured, else the chat
  model on its own prompt key `knowledge-decide`): *same entity?* — a mention that linked to
  nothing but sits near known entities of its type (trigram ≥ `NEARBY_SCORE` 0.3 or cosine ≥ 0.75)
  is shown beside them with the facts each side holds, and a confident pick links it, a confident
  `new` creates it without a review item; *same value?* — a new value that differs from a held one
  over an overlapping window is put with both passages: `same` ("per call-out" / "per visit")
  corroborates, `more_specific` ("Marcus" / "Marcus Bell") is `compatible` and neither confirms
  nor conflicts, `different` conflicts. Only an answer at `JUDGE_MIN_PROBABILITY` (0.8) acts;
  unsure, failed or no model at all keeps the literal rule, so a weak model can leave a false
  alarm but never hide a disagreement. Verdicts are stored once per entity, key and value pair
  (`knowledge_value_judgements`, migration `0030`; moved on a merge or promote) and read by every
  state decision — extraction, `recomputeKey`, and a person's decision carrying over a reworded
  re-read. Metered as `knowledge.extraction`. No string rules about names, units or languages:
  a closed set is a `z.enum` in the type (its `.describe()` says which wording means what), and a
  key that names another entity is declared in `refs` (`{ account_manager: 'person' }`): its value
  is resolved like any mention and stored as `value_ref` (`<kind>:<type>:<id>`), compared by the
  entity rather than the text, and returned as `valueEntity` on a fact and `names` on a fact hit.
  Nothing writes a domain column. Re-extracting a document first removes its facts and undoes the
  conflicts they caused — **except a person's decisions**: a fact somebody confirmed
  (`confirmed_at` set, by `confirm` or as the chosen side of a `prefer`) or rejected (only a review
  writes `rejected`) stays in the table while the document is read again, and a new reading of the
  same entity, key and value (the same validity preferred) takes its place IN that row — a fresh
  citation, confidence and validity, the same decision: rejected stays rejected, confirmed stays
  confirmed by the same person, a `prefer`'s loser stays rejected (a confirmed fact whose validity
  moved has its key decided again, `recomputeKey`). A kept fact the new text no longer states is
  deleted when the run ends, unless a section failed (an incomplete reading is no evidence), and
  because the decisions wait in the table rather than in memory a retried run still finds them.
  No decisions table, no migration. A run that wrote or removed facts nudges
  `entity.changed { entity: 'knowledge' }` tenant-wide (the job sends it before it returns,
  `collectingRealtime`). **Cost**: every call is a `knowledge.extraction` row (name embeddings
  `knowledge.embeddings`); `knowledgeExtractionAllowed` is checked before each document, and at the
  cap the job re-enqueues itself for the next UTC day. On the kit fixture (`pnpm eval facts`,
  42 documents, Haiku 5.5, 2026-11-17) one document is one call, about 5,300 input and 700 output
  tokens — **$0.0009 per document** from the eval's `ai_usage` rows — with precision 0.93, recall
  0.71, 83 % of planted conflicts caught, 14 % of flags false alarms and every caught conflict
  preferring the planted winner (`docs/EVALS.md`; run to run the false-alarm share moves by about
  ten points). Sonnet 5.5: 0.98 / 0.80 / 83 % / 17 %, at about 19× the cost — a stronger model does
  not lower it. With the decision model, units as an enum and people as entities (2026-11-18,
  Haiku 5.5 extracting and judging, five runs against two of 0.37.0): 85 % of planted conflicts
  caught (was 83 %), 18 % of flags false alarms (was 25 % over the same two-run baseline), F1 0.84
  (was 0.81). The 10 % aimed for is still not met: most of what remains is the extraction model
  misreading a value (a visit day from a proposal, a wrong table column), which no comparison can
  undo.
  **Reading facts** (`facts-read.ts`, `facts-sql.ts`): a fact is read through its document —
  every query inner-joins `documents` and ANDs `visibleDocuments(scope)`, so a fact whose
  document you cannot open does not exist for you (404, never 403), and neither does a staging
  entity known only from such documents. A fact `conflicting` only with hidden facts reads, for
  that reader, as the state it would return to without them (`accepted` / `unconfirmed`), and its
  `conflicts_with` names only visible facts — a hidden document must not leak even "another source
  disagrees". A fact `superseded` only by a hidden fact reads the same way — its restored state,
  `superseded_by_id` null — and is answerable (`lookup_facts`), current (`GET /entities` counts)
  and reviewable for that reader; a `confirm` by them records the confirmation and leaves the
  stored supersession for the readers who can see it. `lookup_facts` and `search_knowledge` resolve
  names through the reader's view too, so an entity known only from hidden documents answers like
  a name nobody knows. Admin-level readers see everything. **Review API** (`/api/knowledge`, behind
  `requireFeature('knowledge-facts')` → 404 `feature_disabled` when off; CASL subject
  `KnowledgeFact`: member `read` + `update`, admin+ `manage`): `GET /review` (open facts and
  possible matches addressed to me — everyone's for `manage KnowledgeFact`, `?mine=true` narrows —
  newest first, paginated over both kinds with one UNION; `?kind=`, `?entityType=`, `?entityId=`);
  `GET /documents/:id/facts` (the facts read from one document, grouped by entity, every state;
  404 for a document the reader cannot see; `entityTypesRegistered` says whether extraction has
  anything to look for); `GET /entities` (the entities with CURRENT facts — accepted, unconfirmed,
  conflicting — the reader can see, with `facts` / `needsLook` counted over visible facts only in
  one GROUP BY, filters `type` / `sourceKind` / `needsLook` / `q` (staging names and aliases;
  a domain row's own label is not searched), facets over every visible current fact, paginated);
  `GET /mentioned?q=` (the facts about the entities a query names — `search_knowledge`'s facts
  block, for the Search page — read through the same visibility);
  `POST /facts/:id/review { action }` — `confirm` (→ `accepted`, `confirmed_by/at`, trust
  unchanged; 409 `fact_conflicting` on a conflict), `reject` (→ `rejected`, unlinked from every
  conflict; a side left disagreeing with nothing, or superseded by it, returns to `accepted` — when
  confirmed or confident — or `unconfirmed`), `prefer` (→ `accepted` and confirmed; every
  conflict the reviewer can see becomes `rejected`, not `superseded`: superseded means "true for an
  earlier window", which an `asOf` lookup answers with and re-extraction restores, while a person
  choosing between two values for the same time has said the other was never right; a conflict
  from a document hidden from the reviewer stays linked, so the fact stays `conflicting` for the
  admins who see both); 409 `fact_not_reviewable` on `rejected` / `superseded`. Only the item's
  reviewer or a manager acts (403). Because `prefer` settles the other sides too, a member may
  prefer only when every visible conflict is an item they review and no other person confirmed;
  otherwise it is a 403 `fact_conflict_needs_admin` with nothing written (the UI shows the
  message as an error), the conflict stays open for an admin, and the member can still `reject`
  their own side. `GET /entities/:type/:id` — the entity card (staging by uuid,
  or a domain row of a registered type: its label, the names of staging entities promoted to it as
  aliases), every visible fact in every state. `POST /entities/:id/merge { into }` (a staging
  target of the same type: names become its aliases, `merged_into` set, facts moved — to the row a
  promoted target became; a domain `into` is a promote), `/promote { id }` (a row of the entity's
  own registered type, found through its table's id column or its resolver in this tenant, 400
  `entity_target_not_found` / `entity_type_not_promotable`; records `promoted_type` /
  `promoted_id` and moves the facts onto the row — never a domain column), `/keep-separate`
  (closes the possible match). Merge and promote re-decide, with `decideFactState` oldest first,
  every key BOTH entities held answerable facts for (a confirmed fact counts as fully confident);
  keys only one side held keep their states; 409 `entity_settled` on a second settle. They are a
  person's actions over HTTP, so no approval gate — `Tool.requiresApproval` is what an AGENT tool
  doing the same would need, and none is exposed. Each action writes an `activity_events` row
  (`knowledge.fact.reviewed`, `knowledge.entity.merged|promoted|kept_separate`) and, after its
  transaction commits, nudges `entity.changed { entity: 'knowledge', id }` tenant-wide (an id,
  nothing else; `access.changed` also invalidates `['knowledge']`, since a fact is read through its
  document). A fact review item names its entity (`entity { kind, type, id, name }`); the card
  says whether the entity can be promoted (`promotable`) and who settles it (`reviewerUserId`); a
  possible match is counted in `pagination.total` only when the reader can see a candidate.
  **UI** (React; everything behind `KNOWLEDGE_FACTS_GUARD` = the flag AND `read KnowledgeFact`,
  so a tenant without the flag neither sees nor fetches any of it): the **entity page**
  `/knowledge/entities/:type/:id` (`entityPath`) — facts grouped by key, current first (value,
  state, validity, the source document linked to the passage, the verbatim quote), superseded and
  rejected as the key's history, both sides of a conflict together; a possible match with Merge /
  Keep separate; Promote (a row id of the type) where `promotable`; a merged or promoted entity
  says where it went. **Inline doubt** on every open fact, there and in the review list: "Is this
  still right?" — Confirm and Not right, or Use this one and Not right on a conflicting fact —
  shown only to the item's reviewer or a manager (anyone else reads one sentence). The **review
  list** is a "To review" view of the Knowledge page (`/documents?view=review`), not a queue page:
  open items, filterable by kind, "Only mine" for a manager, each linking to its entity, a
  conflict shown once with every side (the API lists each side as an item). Beside it, a
  **Facts** view (`/documents?view=facts`) BROWSES every entity with facts — name, type, fact
  count, how many need a look, last seen; filters for type, "Needs a look" and source kind, a
  name box, paging; each row opens the entity page — and the **document viewer** has a Facts tab
  (`?tab=facts`): the document's facts by entity, each with its quote and "Show in document",
  which opens `?tab=document&offset=&end=` and marks exactly that span in the Plain view. The
  **badge** on the Knowledge nav item counts MY open items (`GET /review?mine=true&pageSize=1` →
  total), fed by the nudge and never polled. In **chat**, a turn that used `lookup_facts` or the
  `search_knowledge` facts block shows a compact card per entity (name, type, the facts the tool
  returned with state badges, a link to its page): `CUSTOM kit.entity` while streaming, the same
  pure mapper (`entityCardsFromToolCalls`) over the persisted `toolCalls` afterwards. No success
  toasts anywhere: a settled item updates in place; a 409 is `alert-info` and a refetch.
  **Chat tools**,
  only for a tenant with the flag (`buildAgentTools` reads `AgentToolContext.features` — chat
  passes `auth.features` — else the tenant's): `lookup_facts { entity?, type?, key?, asOf? }`
  (entities by name: staging trigram, the better of `similarity` and `word_similarity` ≥ 0.5, a
  promoted one as its row, then each registered type's resolver) and a `facts` block on
  `search_knowledge` for the entities the query names (`word_similarity(name, query)` ≥ 0.7).
  Both answer `factHitGroupSchema`s: facts grouped by entity, each with its state in the reader's
  view, `preferred` (`preferredFact` over the visible sides), the document title and quote, and
  validity; `rejected` never, `superseded` only when `asOf` falls in its window. The chat prompt
  and both tool descriptions require stating uncertainty and citing every side of a conflict,
  never picking one silently. On the fixture (`pnpm eval conflicts`, Haiku 5.5, 2026-11-17) 16–17
  of the 18 conflicted entity/key questions pass the rubric "every value with its source, and the
  disagreement said" (mean 0.89–0.94 over two runs); each failure was the judge refusing a real
  corpus document the rubric did not list, not a side left out.
- **Usage**: one `ai_usage` row per call, costed at write time from the one price table
  (`shared/ai/pricing`; an unknown model gets `null` and is counted as unpriced). While a cost cap
  applies to a run the deployment pays for (the platform key or the Workers AI binding), a chat call
  on an unpriced model is refused before it is made (run event `agent_budget_exceeded`), because its
  cost could never reach the cap. A tenant's own key is its own spend, so it is not refused.
  `ctx.decide`'s chat fallback (no TypeSafe key anywhere, prompt key `agent-decide`) is metered the
  same way, call by call: refused before the call on an unpriced model the deployment pays for —
  judged on who pays for the `agent-decide` model, not the agent's own — and ledgered as each call
  returns, so a decide whose answer fails validation twice still leaves both rows.
- **Tracing (D32, supersedes D16's Langfuse ingestion client)**: `api/observability/`. Every AI call
  site talks to the `Tracer` seam; the recorder batches ended spans and flushes (in `waitUntil`, or
  awaited at the end of a stream, step or job) to two sinks: our own **OTLP/HTTP exporter**
  (`otlp-fetch.ts` — JSON by default, hand-encoded protobuf for backends that take nothing else,
  e.g. Phoenix; no dependency, no Node API) and the **local `ai_spans` table**, written whether or
  not a backend is configured (the request path opens its own short-lived client per non-empty
  flush). Attribute names — OTel GenAI semconv, OpenInference, Langfuse aliases — live in ONE module,
  `genai-attributes.ts`. Handles nest, and the active span rides `AsyncLocalStorage`, so a tool
  span (recorded by the kit's single tool runner — every tool, kit or plugin, chat or run),
  retrieval and embeddings nest without signature changes. **Workflow continuity**: a run's trace
  id is its uuid's hex and its root span id is derived from it, so each `execute#N` (a separate
  invocation) is a child of a root the `finish` step records once the run has settled. Covered:
  chat turns, agent runs, tools, retrieval, embeddings, the `chat.compact` / `document.index` /
  `document.convert` jobs. `OBSERVABILITY_PRESET` (`langfuse|phoenix|generic`) fills endpoint and
  auth — existing `LANGFUSE_*` keys migrate with no new secret; content capture is off
  by default, and `OBSERVABILITY_CAPTURE_CONTENT=true` records prompts, completions and tool I/O in
  both sinks; `pruneAiSpans` on the nightly cron keeps
  `OBSERVABILITY_SPAN_RETENTION_DAYS` (14). Read back through `GET /api/traces[/:id]` (`read
  Trace`, admin+ — spans hold other people's prompts) and `rocketflare traces list|show`; the
  `rf-traces` skill teaches an agent to debug from the span tree. Switch recipes: `docs/DEPLOY.md`
  § Tracing.

  **D32 decisions** (design grilling, 2026-09-25): our own OTLP exporter behind the existing seam —
  not Cloudflare's native tracing, not the Langfuse SDK · the backend is platform-wide only ·
  content capture was decided on by default but SHIPPED off (`OBSERVABILITY_CAPTURE_CONTENT`
  defaults to `false` in `config.ts`: prompts are other people's data, so capture is opt-in) ·
  agent context comes from the CLI
  reading our own Postgres, not a backend REST adapter.
- **Evals (D33)**: `apps/evals`, its own workspace package because vitest-evals needs vitest 4 and
  the kit's suites are on vitest 5. `pnpm eval [suite] [--model x] [--judge-model y] [--compare]`
  runs `suites/**/*.eval.ts` against the TEST database with real models (the platform
  `ANTHROPIC_API_KEY` from `.dev.vars`; no key → every suite skips and says why). **Targets are
  in-process and go through the product's own code**: the chat target drives the real
  `POST /api/chat/conversations/:id/messages` route (so `prepareChatTurn` decides prompt, history and
  tools, as in production); the agent target runs `enqueueRun` → `claimStep` → `executeRun` →
  `finishStep` inline. Each case gets a tenant of its own with its `context` documents ingested, so
  retrieval can only find what the case put there. A **corpus** (`datasets/**/<name>/docs/*.md`
  plus answer keys — `docs/EVALS.md` § Corpora) is ingested once, with a REAL embedder only, into
  a tenant its cases share; `knowledge · retrieval` grades the ranking (`Recall@k`, `MRR` in
  code), and the kit's own fixture, `datasets/kit-only/brightside/`, is kit-only. Everything a target does runs in
  `withEvalScope` (`observability/context.ts`), which marks its traces `rocketflare.eval=true`.
  **The harness input IS the `EvalCase`** (`shared/ai/evals.ts`: input, messages, context,
  expected `{ output, rubric, tools, toolsMatch, contains }`, tags, source), so judges read each
  case's own expectations; `describeCases` attaches to a case only the judges it declares something
  for, because vitest-evals averages a `null` score as 0. Deterministic judges (`Contains`,
  `Matches`, `Schema`, `Trajectory` with agentevals' strict/unordered/subset/superset, `Budget`)
  come first; LLM judges (`Rubric`, `Faithfulness` against what retrieval actually returned,
  `Reference` = vitest-evals' `FactualityJudge`; `ContextPrecision` for retrieval) run through ONE judge harness that calls the kit's
  resolver on the `evals-judge` prompt key — so `agent_models` can pin it, `--judge-model` overrides
  it, and every call is an `ai_usage` row under `evals.judge`. `--provider` / `--judge-provider
  fireworks|gemini` put the target or judge on a real encrypted tenant `ai_configs` row
  (Fireworks through the kit's own `fireworks` preset, Gemini as `openai_compatible`), so vendor
  comparisons also exercise the tenant-config tier. A run is a vitest JSON report in
  `.evals/runs/<ts>-<sha>.json` (git-ignored), stamped with the sha, models and prompt hashes;
  baselines are committed per suite (`baselines/<suite>.json`, `pnpm eval:baseline`) and
  `--compare` exits 1 on a per-case, per-judge drop past `--threshold` (0.1). `pnpm eval:view`
  prints the score diff between two runs, then serves the vitest-evals report UI (runs, cases,
  transcripts, judge rationales). The optional `evals.yml` workflow runs it on manual dispatch or a
  `run-evals` label, outside the gate. How-to: `docs/EVALS.md`; the `rf-evals` skill drives it.
- **Feedback and promotion (D33)**: thumbs on assistant messages and run output
  (`POST /api/feedback`, `create Feedback` for every member, on an answer they can READ — another
  member's thread is a 404, admins included). One row per `(tenant, target, user)` in
  `ai_feedback`; voting again replaces, the same thumb twice withdraws. Each vote is also a
  zero-length `feedback` span under the answer's trace root (`rocketflare.feedback.rating`), shown by
  `rocketflare traces show`. AG-UI capabilities now declare `feedback: true` for chat and runs.
  Admins (`read Feedback`) list the queue (`rocketflare feedback list --rating down`) and
  `GET /api/evals/export?messageId|runId` drafts an `EvalCase` — question, history, the passages
  retrieved, the tools called, the OBSERVED answer as `expected.output`, the feedback — which
  `rocketflare evals promote <id> --dataset <name>` appends to a dataset after warning that it is
  tenant data (it will not write without `--yes` or a confirmed prompt).

  **D33 decisions** (design grilling, 2026-09-25, issue #21): vitest-evals as the runner, in its
  own vitest-4 package rather than a workspace-wide vitest upgrade or a home-grown runner · targets
  in-process, through the real route and runtime · no in-app eval UI (JSON runs + the report UI) ·
  datasets are code; promotion from real traffic and thumbs · the judge goes through the resolver,
  with a `--judge-model` override · in core, not a plugin · the `rf-evals` skill is a first-class
  deliverable. The prompt key is `evals-judge` (keys are kebab-case); the ledger feature is
  `evals.judge`.
- **Rejected**: Cloudflare's Agents SDK. Per-instance SQLite sits outside RLS, the tenant FK cascade
  and cross-tenant indexes, and the inbox would need Postgres anyway. One `step.do` per model turn
  was also rejected: steps are unlimited in wall-clock time, and splitting would force every side
  effect outside a step to replay.

**Known gaps:** model traits are parsed from the id and hand-kept (`MODEL_TRAITS_CHECKED`), not read
from the Models API; no `effort` setting (thinking is on/off — on means the model's default); Haiku
5.5's > 100k-token price tier is not modelled (`pricing.ts` uses the ≤ 100k rate); OpenAI tools are
sent non-strict; an assistant message's `phase` is not replayed to the Responses API;
no document summary or thumbnail (the card is an excerpt; Workers cannot rasterise);
no images inside rendered Markdown (a model's or document's image is shown as a link,
`MarkdownImageLink`); `charOffset` does not map to PDF pages; no frontend tools in chat and no human approval in chat (a
tool with an approval gate is available to agent runs only), no `STATE_DELTA`; protobuf has no
stream cursor; a cancelled CHAT turn emits nothing rather than AG-UI 1.0's `RUN_FINISHED`
`cancelled` outcome (the client closed the socket — agent runs do emit it); no token-level streaming for runs (would need a per-run DO); char-based history budget
not derived from the model; sliding window defeats prompt caching on long threads; `enqueueRun`
does not pre-resolve the client; Workers AI forced tools on off-list models are best-effort;
lexical search is English-only (`SEARCH_TEXT_CONFIG` is one constant, not per tenant);
reranking: the Workers AI `bge-reranker-base` default is not yet measured against the fixture —
neither recall nor latency at 20 candidates, nor whether its 512-token input limit truncates an
800-token chunk (`pnpm eval retrieval --rerank workers-ai` needs a Cloudflare API token) — and its
logits-vs-probabilities reading is a per-batch heuristic, every search with `[ai]` bound pays one
extra Workers AI call, the Fireworks reranker adds ~0.5 s per search at 20 candidates (~0.8 s at
50), `RERANK_MIN_SCORE`'s scale is per model so the kit ships it off, and the global-search plugin
still carries its own copy of the client until it switches to the core seam (the plugin API's
`searchKnowledge` now returns `rerankScore` and the `rerank` outcome) in its own repo;
knowledge metering: Workers AI embeddings and rerank tokens are character estimates, a rerank that
timed out is recorded as billed, platform-document ingest (tenant-less) is unmetered, and
platform documents are never extracted; knowledge facts: about one flag in five is a false
alarm on the fixture (18 % over five Haiku runs, 0–24 % run to run; 10 % was the aim), mostly
misread values; an entity's NAME is the first document's wording, so one created from a
group-restricted document keeps that name once a tenant-visible document links to it, aliases
stored by an earlier release stay on their entity, and entity resolution (not the prompt) still
compares a mention with every staging entity of the tenant; Promote asks for the domain row's id
(there is no picker searching the type's rows); `search_knowledge`'s facts block finds only entities with a staging row
(a domain row that never had one is reached through `lookup_facts`' resolver, not by being named
in a query); a person's decision survives re-extraction when the new reading repeats the fact's
entity, key and value, or a value a decision model already judged the same — a pair never judged
(the re-read document is the only one stating it) or an entity resolved differently comes back as
a new open item; a nudge carries no reviewer, so every member's badge refetches on any settle; the default
resolver matches domain rows by trigram only (no embedding — a domain table carries none); two
extractions of one tenant running at once can each miss the other's facts (no per-tenant
serialisation), so a conflict between them goes unflagged until one is re-extracted; the
staging trigram lookup scans the tenant's entities of that type (the GIN index serves `%`, not
`similarity() >=`); the decision model is asked about an entity only when trigram or embedding
puts a known one nearby (`NEARBY_SCORE` 0.3, cosine 0.75), so two names sharing no words stay two
entities; the value judge is asked only about pairs whose validity overlaps and never about a key
that names an entity (`refs` compare by the entity resolved); with no model at all every
judgement is skipped and the literal rule stands; the model still reads proposed values from a
proposal now and then; a
year-less date more than 90 days before the document is read as next year; a validity window
stated on one side only is a conflict, not a change over time; page numbers: `toMarkdown` emits no page markers, so `chunks.page` is always null;
chunks written before 0.37.0 keep their old shape (no heading path or offsets) until re-indexed,
and an unchanged upsert never re-indexes them (re-embed rebuilds only another model's chunks); a
stale document is found by keyword only until its re-embed lands; two re-embed chains for the same
model (a double `POST /reembed`) both run, wasting embeddings calls but not duplicating chunks; a
document the provider keeps refusing transiently holds its tenant's re-embed until the message
dead-letters (`POST /reembed` restarts it); no UI for the health count or the re-embed; Retry
re-runs the same input, so a document that failed on content (too long, unconvertible) fails
again; the plain-ingest dedupe is a read, not a constraint, so two
concurrent identical ingests can both create a row; platform documents cannot be opened with `get_document` (a
search hit is all a model reads of one), are not re-embedded automatically when the platform
embedder changes (the next `ingestPlatformDocument` re-indexes; until then they are found
lexically), and have no admin view; HITL asks cannot be amended, have no
reminders, and parks are bounded by instance retention (3 days Free / 30 Paid); runs nobody opens
stay active-looking; no prompt versioning. Volume (D39): the active-run cap is counted, not locked,
so a burst can overshoot it; a budget is checked BEFORE a call, so a run overshoots by its last
call and, under `ctx.map`, by the calls in flight; **chat has no spend cap**: the run budgets and the
daily cap meter agent rows only, so a chat turn on a platform key is bounded by nothing but its turn
and output-token limits; the daily cap is a UTC day and TypeSafe is unpriced, so decisions count
toward tokens alone; `map`
runs inside one step on one DB client (six in flight is the ceiling; a tool loop inside a scope
has no checkpoint and resumes only through its journal, re-reading every recorded turn); a budget error raised inside a tool
handler is reported to the model as a tool error rather than stopping the run; no batch UI, no
per-batch cancel, and a batch's runs are not grouped on the runs page. Policy (D39): when a handler
raises an interrupt under concurrent execution, in-flight sibling results are discarded and run again
on resume unless the loop has a journal, which keeps the siblings that settled; without a journal a
salvage that succeeds and then loses its step is paid for again; `maxDurationSeconds` does not count time
between the last checkpoint and a crash; a policy reaches a loop only when the agent passes it
(`runToolLoop` has no registry to read); `authorizeTool` is per loop, not a run- or tenant-wide
rule. Decisions (D37): no
zod-schema → questions compiler, the `llm_self_report` fallback is uncalibrated with no vote/logprob
mode, TypeSafe calls are unpriced (no published rates), no per-agent decisions provider
(`agent_models` is chat-only), and a `sift` over 100 items is the caller's to batch. Durable loop
(D44): only a loop given `journal` records anything (a hand-built `runToolLoop` without it behaves as
before); a `started` marker is written before the handler, so a side-effect call that died before
it sent anything still settles as an unknown outcome; an unrecorded read re-runs and may answer
differently, which re-asks every later turn; a recorded tool result is trusted by `toolCallId`
alone (provider ids are unique per response — an adapter that minted repeating ids would collide);
a key conflict is detected within one attempt, not between two attempts that reached different
code; a `ctx.once` without `inputs` is still the author's key; `callStructuredTool` and
`ctx.chat.client` calls outside a loop are not journaled (wrap them in `once`). The run-engine seam
covers the Workflow step only — jobs, realtime and storage are still Worker bindings, unlike
Rocketpod's `Platform`. Operability (D44 phase 2): cancel is polled (up to 3 s late, one indexed
read per poll while an attempt runs), and a model call abandoned mid-flight may be billed by the
provider with no `ai_usage` row; the sweeper checks 100 runs per 10 minutes, so a backlog of lost
runs drains over several sweeps; Workflows' per-Workflow `concurrency.limit` (2026-11-10) is NOT
set — it caps instances across ALL tenants and does not count `waiting` ones, so it cannot back
the per-tenant active-run cap (counted, then inserted); it is a platform-wide cost/noisy-neighbour
knob, set in BOTH tomls on every deploy if you want one (`docs/DEPLOY.md`). Phase 3 (D44): versions
are detected, never prevented — Workflows still resumes a parked run on today's code, and
`onVersionChange` only decides what happens next; the recordings check sees only the runs you
commit (record from dev or seeded tenants — a recording holds the run's input and model turns), and
its turn drift is not checked (a system prompt naming the tenant drifts by design); `rerun` is a new
run, so a parent waiting on a child that reran sees the child `cancelled`; an `onTimeout: 'reject'`
deadline is applied by the 10-minute sweeper, so it lands up to ~20 minutes late, and at the
`AGENT_INTERRUPT_TIMEOUT` cap the Workflow's own wait ends first and cancels — keep `hitl.timeout`
shorter; reminders are one per ask; assignees are checked against tenant membership at notify and
answer time, not when the ask is raised; a child's budget share is fixed when it is spawned (two
children spawned together may each get the whole remainder — the parent's meter, which counts both,
is what stops the overspend, at the parent's next call); there is no fan-in primitive beyond
`Promise.all` of spawns, no depth limit beyond the budget, and a child never steers its parent; the
inspector is read-only and shows no transcript (the trace and replay do). Replay (D38): a tool loop replays strictly only inside the journal's
retention window — an older run's first turn is a `chat` miss, and `--live` is the fallback; steering
notes are all handed over at the first call; a run that predates a `once` key misses it; no route
or UI (a local script over a database URL), and `--live` holds one read-only transaction per run. The demo seed's
vectors are deterministic, so dense search over seeded docs is noise. Tracing: no per-tenant
backends (BYO keys via `sealSecret`), no native `tracing.enterSpan`, no metrics export, no
Langfuse/Phoenix MCP; inline ingest from `POST /api/ai/documents/ingest` is untraced (no active
span); the backend receives a run's root only at `finish` — before that it has the `run started`
span and each finished `execute#N`, never a long step's spans before the step ends; the GenAI names
are pinned to semconv `GENAI_SEMCONV_VERSION` (1.45.0, sent as `schemaUrl`) and the agent spans
are still Development upstream; `gen_ai.*_ref` points at the app's own `GET /api/traces/:id`, only
when content is captured (auth-gated, never a signed URL — and gone after the 14-day retention);
exported content is capped at 32 000 chars per value. Evals: no in-app eval UI or dataset editor;
the report UI has no side-by-side view (the diff is `eval:view`'s terminal table); no HTTP targets
against a deployed instance, no red-teaming, no push to Langfuse datasets; a run that parks on a
person scores as a miss (an eval cannot answer it); run faithfulness sees each passage's
600-character event preview; without `EMBEDDINGS_API_KEY` retrieval in evals leans on the lexical
half of hybrid search; `--provider` knows three vendors (anthropic, fireworks, gemini) and the
latter two are unpriced; a thumbs vote is a
zero-length span, not an OTLP span event, and is not traced when the answer's root was pruned.

## 10. Deployment

Two standalone tomls (D6) kept identical in everything code can see by `wrangler-parity.test.ts`.
Account-scoped names carry `-staging`. Neon uses one project with a branch and role per
environment; under `postgres` Hyperdrive points at the direct host, under `neon` the Worker's
`DATABASE_URL` secret holds the pooled one (D35). Tagging `X.Y.Z` (which must equal the root
version) deploys staging; publishing the Release deploys production. `ci.yml` is ONE gate job — the
secrets scan, then `pnpm gate` (§4), narrowed to `pnpm gate build` only on a tree Launch already
gated when `LAUNCH_GATE_APP_ID` is set (§4, "Verified once") — which `deploy.yml` calls only when there is something to
deploy (`guard`) and the commit has no successful CI run yet — nor, for a version-only bump (the root
`package.json` `"version"` and nothing else, `release-check.mjs --version-only`), does its one parent:
a commit is gated once, and the kit's
own tags (nothing to deploy) finish in seconds with a summary saying why. The kit's renamed-copy
and default-plugins gates, its porting-note and plugin-API checks live in `kit.yml`, which is
`kitOnly` — a copy has no such file — and is a pull-request check, never a deploy precondition. `pnpm provision <phase>` / `/rf-provision` automates
accounts → resources → secrets → deploy over REST. Reference: `docs/DEPLOY.md`, `SETUP.md` Part 3.

**External deployer (opt-in).** A Cloudflare token that can deploy a Worker can bind any resource in
the account into it, so a CI job holding one can reach other apps' data. With the repository
variable `DEPLOYER_URL` set, `deploy.yml` holds no Cloudflare token and no database credential: it
proves who it is with a GitHub OIDC token and hands the dry-run build to a deployer that checks the
bindings, stores an undeployed version, issues short-lived migration credentials, then activates
(`scripts/deployer.mjs`; the v1 contract is `docs/DEPLOYER.md`). Unset, the default path is unchanged.

**Build once (deployer path).** Production used to rebuild the tag, so Live never ran the bytes
Staging validated. Now staging packs its build into `launch-bundle-<tag>.tgz` and attaches it to a
DRAFT GitHub Release (a draft fires no `release: published`, so nothing promotes early); publishing
the draft deploys exactly those bytes after `scripts/bundle.mjs` checks the digest, tag, commit and
tree against the checkout. The bundle is environment-neutral — every binding and var comes from
the toml the deployer receives — and GitHub Releases stay the external record. No asset → today's
build (`docs/DEPLOYER.md` → Build once).

Cloudflare evaluates the bundle's top level when it is uploaded and refuses a random value, a
timer or I/O there (error 10021); nothing local does, so `tests/config/global-scope.test.ts`
loads the Worker with them made to throw.

**Known gaps:** no release helper beyond `kit:release`; no per-PR previews; no CLI publishing;
provisioning HTTP calls have not been run end-to-end against live accounts; no automated
Workers-plan check. The kit ships no deployer, only the client and the contract; the job waits for
approval on a runner (fine for minutes, wasteful for hours — there is no re-dispatch). A deploy
dispatched while the pushed commit's CI run is still in progress gates again rather than waiting
for it. Build once covers only the deployer path, and only a promotion that PUBLISHES the staging
draft: a new release created for the tag instead has no bundle, so production rebuilds. Every
upload carries its `digest` and `source` (`bundle` | `build`), but comparing production's digest
with staging's is the deployer's job (Launch refuses a `bundle` upload that differs), not the
kit's; a staging dispatch from a branch packs nothing. A failed attach is a warning on a green run, not a
red one (staging is live), and leaves that tag to build at promotion; unpromoted bundle drafts are
pruned to the newest `BUNDLE_KEEP_DRAFTS` (5) after each attach.

## 11. CLI

A thin client over `/api/*` using a tenant API key. It parses with shared schemas and never keeps
a second copy of the contract (D26). `api.ts` is the only `fetch` site. Config lives in
`~/.rocketflare/config.json` (0600); `ROCKETFLARE_API_KEY`/`ROCKETFLARE_URL` override it for CI.
`--json` is available on every read. `traces list|show` reads the local AI trace store (D32);
`feedback list` is the thumbs queue and `evals promote <id> --dataset <name>` appends a draft eval
case to `apps/evals/datasets/` (D33, both admin+). `agents list`, `agents run <key> --input x.json |
--batch x.jsonl` (chunks of 100, failed lines reported, exit 1) and `agents runs list [--batch id]`
start and follow runs (D39). Exit codes: 0 ok · 1 error · 2 not logged in ·
3 forbidden.
No command prints a full key. Human output shows server text as inert text: `renderTable` cells,
free-text lines and the logger drop terminal control characters, and colour is applied after that
(a column's `style`); `--json` is unchanged. Plugins register top-level commands named after their id.
Detail: `.claude/rules/cli.md`.

**Known gaps:** no device-code flow; one profile at a time; `logout` does not revoke the key; no
shell completion; not published; no knowledge commands (documents, search and fact review are
the API and the UI only).

## 12. Shared package

`packages/shared` is private and has no build step: `@rocketflare/shared/<module>` resolves to
`src/<module>.ts` (so a plugin entry is `…/plugins/<id>/index`). Contracts come first (D13): a new
API surface starts here. Allowed imports: `zod`, siblings, type-only `@casl/ability`, and
`@ag-ui/core` only in `ai/agui.ts` (`shared-imports.test.ts`). It never imports `apps/*`, and
`src/plugins/**` never imports one of the five composers at runtime (that would create a module
cycle). Detail: `packages/shared/CLAUDE.md`.

**Known gaps:** no own test suite; no OpenAPI; no contract versioning between web and CLI.

## 13. Upgrading a copy

**A renamed copy with deleted examples still absorbs later kit releases (D27).**

- **`.rocketflare.json`**: kit `{id, repo, version, commit}`, the app's names (`app === null` means
  "this is the kit", asked only through `readManifest()`), `history[]`, `retiredSurfaces`
  (never deleted), and the **surface manifest**. Surfaces are `example`, `optional-feature` and
  `plugin`, each with an anchor file whose existence is its presence (delete the anchor to opt
  out). Every other path is `neverPort`, `kitOnly`, `manual` or `core`; the kit's own
  `tests/kit-only/kit-manifest.test.ts` requires 100% coverage — an app's new paths never appear in
  a kit diff, so a copy owes the manifest nothing for them.
- **Kit-only files** (`kitOnly`): what is true of the kit repository and of nothing made from it.
  Its tests (`apps/web/tests/kit-only/**`, vitest project `kit-only`) — porting notes and the root
  version being the kit's, the release/rename machinery, the maintainer hooks, plugin CI, the
  manifest's kit-state claims, the Launch conformance checker's own tests, the kit's doc guards —
  which the kit's gate runs (`pnpm test` names the project only while its directory exists); its
  workflows (`kit.yml`, `plugin-ci.yml`, `notify-plugins.yml`); its maintainer scripts
  (`release.mjs`, the two nudges and `nudge-lib`, `default-plugins.mjs`, `install.sh`); and its
  project files (`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, the pending porting notes
  `docs/upgrades/unreleased.md`). `scripts/rename.mjs` deletes them when a
  copy is born, and with them every package.json script (`kit:release`) and `.claude/settings.json`
  hook that names one (`stripKitOnlyWiring`, `stripKitOnlyHooks`); it also writes the app its own
  `SECURITY.md`, drops `retiredSurfaces` and records the scripts it removed as `kitOnlyScripts`,
  which `/rf-agent-docs`'s check reads so kit text naming them ("in the kit repository only") is
  not a failure in a copy. `classifyPath` never ports one (the TARGET kit's list too, and `KIT_ONLY_PATHS` is the
  floor for a pre-0.15.8 manifest); `tests/config/kit-manifest.test.ts` fails a copy that carries
  one or a script or hook that calls one, and `kit.yml`'s renamed-copy gate asserts none survive
  and passes at an app version (`1.2.3`).
- **The Launch kit contract** (`launch.kit.json`, D36): what the kit calls things and how Launch
  drives an app made from it — the scaffold (`rename.mjs`, `kitOnly`, `postInit`, the app manifest
  `.rocketflare.json` whose `kit.id` Launch reads), the two tomls and the `{slug}-{suffix}` naming
  (with `worker.titles`: `RATE_LIMIT_KV` is titled `<slug>-rate-limit`), the vars and secrets Launch
  provides, the database roles and migrate command, the health routes, the gate (`Gate`,
  `pnpm gate --list --json`, `LAUNCH_GATE_APP_ID`, `TEST_DATABASE_*`), `deploy.yml` (deployer
  protocol v1), the session commands (the bootstrap with `--db-url`, the dev server, its ports and
  sandbox switches), the upgrade command and skill, and `plugins.defaults` — a MIRROR of
  `defaultPlugins` above, which stays the source the bootstrap and `kit.yml` read (a kit-only test
  holds them equal). Its shape is Launch's zod schema (`@launch/shared/kit-manifest`), mirrored in
  plain JS by `scripts/lib/kit-manifest.mjs`. **A copy keeps it**: Launch reads the app's own for
  its sessions, gate and releases, so the rename rewrites it through the token map EXCEPT its `kit`
  block (`renameKitManifest`), and `kit:upgrade` treats it as `manual`. `scripts/kit-check.mjs`
  (`--exec` also runs the gate list) is the static conformance check Launch applies before a kit
  can be picked — shared byte for byte with the meta-kit `rocketflare-dev/launch-kit` (one change
  lands in both) — run by `kit.yml` on the kit and on the renamed `my-app` copy. Its ids rule knows
  which it is looking at: the kit's KV ids are `<PLACEHOLDER>`s; a copy's may be placeholders or
  the real ids Launch's `write_config` commits; `--provisioned` (deploy.yml) wants real ids
  everywhere. **No test judges the checkout it runs in** — config tests travel into every copy,
  which Launch renames and provisions: the checker's and the manifest shape's tests run on a fixture
  kit (`tests/kit-only/fixtures/kit-fixture.mjs`, shared with the meta-kit, which also provisions it
  the way `write_config` does), the toml patcher's on a snapshot of the shipped tomls; the kit's
  own files are judged by `kit.yml` and `tests/kit-only/` (`launch-kit-manifest.test.ts` checks the
  VALUES against the bootstrap, the dev server, the tomls and the RLS role).
- **A copy's version is its own**: the rename restarts the root `package.json` version at `0.1.0`
  and empties `CHANGELOG.md` (`restartAppVersion`, only while the root version is still the kit's),
  so an app's releases never read as kit releases. Which kit it came from lives in one place,
  `.rocketflare.json` `kit.version`; the upgrade never ports the root version or `CHANGELOG.md`
  (`manual` / `neverPort`), so the two numbers never meet again.
- **Porting notes** (kit repository only): one `docs/upgrades/X.Y.Z.md` per release (frontmatter +
  four headings), with `unreleased.md` accumulating. `kit.yml` fails a PR touching
  `apps/**`/`packages/**` without an entry, and the tag gate refuses a release without one.
  `pnpm kit:release` writes everything. An app writes none: `kit:upgrade` reads the notes from the
  kit's mirror, not from the copy's `docs/upgrades/`, and the copy releases by bumping its root
  version and tagging.
- **`scripts/upgrade.mjs`**: a blobless mirror in `.upgrade/`. It classifies paths, drops absent
  surfaces and plugin-owned files (a vendored plugin's are ported as core — it has no release chain
  of its own), translates through the same `applyReplacements()` as the rename,
  then patches with `--reject` as a fallback. A plan run works on a dirty tree; `--apply` needs a
  clean one, `git rm`s the kit's deletions only with `--apply-deletes`, and `git add`s exactly
  what it wrote (rejected files stay unstaged), so the gate's `git ls-files` scanners see the new
  files. It **never** applies kit migrations (snapshots are
  cumulative), writes resource ids into tomls, applies deletions unasked, or ports the root
  version. The version stamp is written last, only on a clean apply — or by `--continue`, once
  every `*.rej` an apply left is resolved and deleted; `pnpm plugin upgrade <id> --continue` is the
  same finish for a plugin. Every release path is checked
  before anything is written, a plan run included: one that is not a plain path inside the
  repository (`scripts/lib/repo-paths.mjs`), is under `.git/`, or reaches an added file through a
  symlink stops the run.
- **A copy starts with a design**:
  - `/rf-start` is the one entry point the website's prompt names. It runs, in order:
    1. `scripts/detach.sh`, which records the kit commit in `.rocketflare.json` and replaces the
       history. `install.sh` and `/rf-setup` §0 run the same script, and all three are `kitOnly`.
    2. setup (`/rf-setup`);
    3. `/rf-design`;
    4. `/rf-adapt`.
  - `/rf-design` asks the shape questions the kit makes expensive later: organisations, roles and
    words, AI, money, non-functional needs, hosting, licence, and integrations, matched against
    `pnpm plugin list --available`. Each decision records the options weighed. It writes
    `docs/design/*.md` and `docs/design/design.json`, runs an independent reviewer, and renders a
    local site in the app's brand (`pnpm design:site`).
  - `/rf-adapt` then reads the names, `docs/design/brand.css` and the licence answer from the
    design. The app's `LICENSE` becomes its owner's, and the kit's MIT notice stays in
    `LICENSES/kit-MIT.txt`. Both paths are `neverPort`.
  - Known gaps: the shape questions are a conversation, so nothing checks that a later stage
    stayed inside the design. That is the end-of-stage review's job, which doesn't exist yet.
- **A copy hears about releases on its own**: a Claude Code `SessionStart` hook
  (`scripts/kit-update-check.mjs`, in `.claude/settings.json`) compares `kit.version` with the
  newest tag at `kit.repo` (`git ls-remote`, cached a day in the git-ignored
  `.claude/kit-update-check.json`; a failed check an hour) and hands Claude one message to relay
  once per session, with the CHANGELOG summaries and a pointer to `/rf-upgrade`. Copies only, a
  fresh `startup` only, never in CI, `ROCKETFLARE_UPDATE_CHECK=0` to silence; any failure is
  silence.
- **The kit reminds its own maintainers too** (kit repository only — both scripts and their hook
  entries are `kitOnly`, so a copy never runs them): two `PreToolUse` hooks on `git commit` —
  `changelog-nudge.mjs` (source changed, no `unreleased.md` entry) and `release-site-nudge.mjs`
  (root `package.json` version changed → update rocketflare.dev after tagging). Both answer with
  `hookSpecificOutput.additionalContext`, because a `PreToolUse` hook's plain stdout reaches only
  the debug log.
- **The security audit travels** (§18): `/rf-security`, its runner and the sandbox are `core`, so
  a copy keeps them; the rename moves its runs root with the config directory
  (`~/.<slug>/security-runs`) and the guard hook with it. `docs/THREAT-MODEL.md` is the copy's
  own: the `threat-model` surface, and `manual` as well, so `kit:upgrade` shows the kit's diff to it
  and never applies one, and never recreates it once deleted.
- **Released history is never rewritten** — every copy pins a commit.

**Known gaps:** a copy pinned before 0.10.1 has no update hook until it upgrades (and
`.claude/settings.json` is `manual`, so that upgrade must add the hook entry by hand); summaries
only for a GitHub-hosted kit; tomls and `.dev.vars.example` are diffed, not merged; the reject rate is not
predicted; pre-manifest copies need `--adopt`; no partial upgrades; nothing checks the adopter ran
migrations; lockstep plugin releases bump every plugin in a monorepo; a copy on 0.15.7 or older deletes
its kit-only tests by hand once (its upgrader predates `kitOnly`); a copy renamed before 0.24.0
keeps the maintainer scripts, `CONTRIBUTING.md`/`CODE_OF_CONDUCT.md` and the two nudge hooks until
it deletes them by hand (`kit:upgrade` stops porting a `kitOnly` file but never deletes one — that
release's note lists them); the rename script itself and `rf-adapt` stay in a copy (`neverPort`),
because Launch's scaffold runs the rename and nothing is left to rename after it; `kit:upgrade` shows
`launch.kit.json` as a `manual` diff translated through the token map, so a hunk touching its `kit`
block reads as renamed (keep the kit's id and name); a copy that predates the contract gets
`kit.id` only by following that release's porting note; `plugins.add` cannot express an entry
without a `subdir` (`--subdir` refuses an empty value), which no default plugin has today.

## 14. Definition of done for the kit

Kit repository only — the bar the kit itself is held to before a release. A fresh agent can clone and run `bash scripts/bootstrap.sh` with zero credentials and land signed in
on a populated demo workspace. From there it must be able to:

- rename the copy (`/rf-adapt`)
- log in by magic link and through the CLI
- invite a member, switch tenants, approve an access request, including under `single` mode
- see live refresh from a second browser and queued email
- upload an avatar
- stream a chat with persisted usage
- run, watch live, cancel and HITL-answer agents across a dev restart, with the approved document
  indexed exactly once
- ingest, upload a PDF and search it
- restrict content by group and watch it disappear and reappear live
- add the analytics plugin (`/rf-plugin add analytics`) and remove it cleanly with `plugin remove`
- port a later kit release skipping deleted examples
- toggle the `example-feature` plugin's flag
- provision and deploy to staging

The full gate stays green at every step. `SETUP.md` is the walkthrough.

## 15. Feature flags

**A feature flag is configuration, not a permission (D30).** Every gate reads the `features`
**array** (`hasFeature`, `requireFeature`, `{ feature }` nav guards), never CASL. A global admin's
`manage all` would satisfy `access Feature:x` and expose unreleased surfaces.

- **Two layers**: `FEATURES_ENABLED` in `[vars]` is the fail-closed release gate, consulted only for
  `environmentGated` flags. Then the admin rollout: tenant override → `on`/`off` → `rollout`
  percentage → registry default.
- **Keys are code** (`FEATURES` + metadata). No migration is needed to add one; orphaned rows are
  inert. Core ships two: `knowledge-facts` (§9, a rollout flag, off by default) and `mcp` (§19,
  environment-gated, on wherever the deployment ships it); `example-feature`'s belongs to its
  plugin.
- **`featureBucket` is a wire format**: FNV-1a over `"<key>:<unit>"` mod 100, with golden vectors
  in `features.test.ts`. It is monotonic (the percentage is never hashed) and independent across
  flags.
- Resolved inside the session query, with no extra round trip. Gate every door: API mounts (404
  `feature_disabled`, not 403), plugin registries, **hooks that create rows**, and nav/routes.
- Admin UI at `/admin/feature-flags`; a tenant override nudges that tenant.
  `GET /api/features` / `rocketflare features list` show effective state.
- **Rejected**: Cloudflare Flagship. It has no notion of your tenants, whole-object `PUT` loses
  updates, it has no local store, and the browser SDK needs a token. It fits the kit's own
  cross-deployment rollouts, not per-tenant entitlements.

**Known gaps:** gated code still ships in the bundle (the server is the protection); no per-user
forcing or scheduling; platform flips reach open tabs only on their next session fetch; no cache on
the Bearer path; flags cannot gate pre-tenant surfaces.

## 16. Plugins

**A plugin is a git repository COPIED into an app, never an npm package (D31)**, translated through
`applyReplacements()` like kit code. Only first-party plugins for now: installing one is as trusting
as merging a PR. A plugin repo mirrors the host tree and ships **no migration, no toml and no
`package.json`**. Working guide: `apps/web/src/plugins/CLAUDE.md`, `/rf-plugin`,
`docs/plugin-api.md`.

- **Outbound**: four published entries (server, UI, shared, CLI). Nothing reaches past them, in
  either direction between core and plugins.
- **Inbound**: a plugin imports the host only through **declared entries** and receives everything
  else as **injected context** (`RequestCtx`, `JobCtx`, `CronCtx`, `ToolCtx`, `AgentCtx`,
  `WorkflowCtx`, `HookCtx`, `SeedCtx`, `DetachedCtx` — thin adapters over kit internals). Two things
  cannot be injected and are entries instead: `@/db/schema/kit` (module-scope table helpers,
  imported by relative path) and the split UI kit (`ui-wiring` for the eager entry, `ui` for lazy
  pages). Tests use `@testkit/{integration,unit}`, whose builders refuse a database handle not
  created by `setupTestDatabase`. `tests/helpers/plugins.ts` enforces all of this, and every
  diagnostic names the replacement import.
- **Six barrels**, one line per plugin each, written by `pnpm plugin add|remove`: shared, server,
  schema, ui, worker-exports (DO/Workflow classes reach `worker.ts`), cli. Each exports an `as const`
  tuple plus a widened list, so an empty kit still typechecks. **Opening a closed set** always
  follows one pattern: `X = [...CORE_X, ...plugins]`. `ServerPlugin<S>` checks handlers, agents and
  prompts exhaustively against the plugin's own keys.
- **Core edits**: a line a plugin needs in a core file outside the barrels (a Vite dev proxy
  prefix, a resolve alias) is a `coreEdits` entry in its manifest (`{ file, after, lines[] }`) —
  a plain path inside the repository. `add` inserts it after the anchor, `remove` reverts it byte for byte, `upgrade` applies the new
  release's list. Never a hand edit. Crons go in `plugin.json` `crons`, written into both tomls by
  `pnpm provision cloudflare <env>`.
- **Namespacing**: the id is `^[a-z][a-z0-9-]*$` (never a reserved barrel or host directory name —
  `api` included) and `^[a-z][a-z0-9-]*$` and namespaces jobs (`<id>.x`), query keys
  (`<id>:`), `/api/<id>`, CLI commands and CUSTOM events. Never `kit.`. Table prefixes are a human
  convention; **two plugins declaring the same table is a `plugin check` failure**.
- **Record**: a `kind: 'plugin'` surface (`source: {repo, subdir, version, commit}`). In the kit or
  with `--local` it goes in the git-ignored `.rocketflare.local.json`. A kit diff never touches
  plugin-owned files. A vendored plugin (`example-feature`) upgrades with the kit: `kit:upgrade`
  ports its files as core, and `plugin upgrade` refuses it and points there.
- **Compatibility is OBSERVED (decision 5c)**: the kit emits a `## Surface ledger` in
  `docs/plugin-api.md` (generated, diff-checked). A plugin's `uses` is **derived** from its imports
  by `pnpm plugin export`, and compatibility is the set difference `uses \ ledger`, checked before
  any file is copied. The one surviving number is a top-level `minKit` floor, compared with the
  HOST's kit version (`hostKitVersion` in `scripts/lib/manifest.mjs`): `.rocketflare.json`
  `kit.version` in a copy, whose root `package.json` is the app's own, and the root `package.json`
  version only in the kit itself. `requires.kit` /
  `requires.pluginApi` are refused by name. CI proves both ends: `kit.yml` runs the gate with
  `defaultPlugins` plus `.github/ci-plugins.json` installed (in the kit's own repository only),
  and plugin repos call `plugin-ci.yml` (floor + newest kit), which installs a plugin's
  `requires.plugins` from the same checkout first and takes the highest `minKit` across the set
  as the floor.
- **Lifecycle** (`scripts/plugin.mjs`): `add` (plan, then `--apply`), `upgrade`, `remove`
  (`--archive`), `list`, `check`, `export`. Every plan step is **declarative, agent (with its
  assertion) or human** — a printed instruction is not a mechanism. The host generates the
  migration (`db:generate --name plugin-<id>-<version>`). `pnpm provision cloudflare <env>` writes
  a plugin's bindings (`kv|queue|r2|workflow|durable_object|images`), crons, prefixes and vars into BOTH
  tomls. DO migration tags `plugin-<id>-vN` are append-only.
- **`plugin check` is an exhaustive oracle**: manifest fields, `minKit`, ledger diff, barrel lines,
  `*.rej`, migration tag, host dependencies (present, at a range inside the declared one —
  `add` writes the declared range, never pnpm's `^<resolved>`; `upgrade` installs what a release
  adds or re-ranges and removes what it drops only when a plugin brought it in — the surface's
  `addedDependencies` record, never range equality — no other plugin declares it and the host
  holds exactly the old range — a range a peer plugin cannot use is refused), worker exports, a tenant-isolation test for tenant
  tables, `onTenantDeleted` for DOs, table collisions, declared skills, and API prefixes missing from a
  `run_worker_first` a restore marked. Each finding names file, line and exact edit.
  Structural checks read comment-free code. It runs where a finding can still be acted on: at the
  end of `plugin add|upgrade --apply` (exit 8 when the tree it wrote fails), in the plugin's own CI
  (`plugin-ci.yml`) and in `kit.yml` — not in an app's `pnpm gate`, because an undeclared import
  compiles and passes the tests and only breaks at the next upgrade, where the check stops it first.
- **Tools**: `tools(ctx)` (renamed from `agentTools`, which is still read when `tools` is absent
  and draws a `pnpm plugin check` warning) may be async and may return `[]`. That is how a tool reaches
  only the tenants that turned it on: the plugin reads its own settings row for `ctx.scope.tenantId`,
  or its flag through `ToolCtx.features()` (`example-feature` does — a dark feature then costs no
  prompt tokens). A builder that throws is logged and skipped. `buildAgentTools` is therefore async.
  Each tool picks where it is offered with `surfaces` (`'chat' | 'agents' | 'mcp'`, absent = all)
  and shapes how an MCP client sees it with `mcp: { title?, annotations?, outputSchema?, scope? }`
  (§9 "Chat": the defaults come from `sideEffects`). A terminal tool or one with an approval gate is
  never offered on `mcp`. **Names**: one list goes to chat, agents and every MCP client, so a name is
  1–64 of `A–Z a–z 0–9 _ -` (`MCP_TOOL_NAME_PATTERN` — MCP allows `.`, the chat models do not) and
  unique across core and every plugin. The builder (`admittedPluginTools`) leaves out, and logs, a
  plugin tool that breaks either rule — the core name or the first plugin keeps it — and
  `pnpm plugin check` fails the same names statically (best effort: a name it cannot resolve from a
  literal or a `const` is left to the runtime). It also WARNS on "Rocketflare" in a tool's `title` or
  `description`, which a client shows under the deployment's own name.
- **MCP**: a plugin's tool reaches MCP clients through `tools` and nothing else — no mount, no auth,
  no token check of its own. `/mcp` resolves the person, their organisation, groups and CASL from
  the connection, lists the tool under the organisation's exposure mode (§19), and calls it with the
  same `ToolCtx` chat would (`requesterUrls: []`). `example-feature`'s `list_example_notes` carries
  the reference `mcp` block. **A plugin proves its tool scopes over MCP** with `callMcpTool(db, tool,
  { as, tenant, args?, scopes?, exposure? })` from `@testkit/integration`: it turns MCP on, writes a
  real connection, lists and calls over the real `/mcp`, and answers `{ listed, listing, isError,
  text, json, structured }` — call it as a member of another organisation, or outside a group, and
  assert the rows are absent (`connectMcp` / `enableMcp` / `mcpClient` for a case that breaks the
  connection afterwards).
  `ToolCtx.can(action, subject)` is the requester's CASL grant, read at build time from their
  current membership (false for a run with no requester): gate a tool that writes on your own
  subject's `manage`, not on `scope.bypass`, which is row visibility and true for `support` too.
  `ToolCtx.requester` is who is calling — `{ userId, role, isAdmin, groups }`, the groups with
  each one's TYPE name — or `null` for a run nobody started (or whose requester was since blocked
  or removed). The caller already resolved it (chat and MCP from the request's auth context, an
  agent run from its requester at execute time, with the same two reads as `can` and `scope`), so
  it costs no query; it is for SCOPING, such as a semantic layer's security context, while a gate
  stays on `can`. `ToolCtx.features()` answers the caller's own resolved flags when it has them
  (chat, MCP) and reads the tenant's once otherwise.
  `ToolCtx.requesterUrls` is the frozen set of http(s) URLs the person wrote themselves
  (`services/agents/tools/requester-urls.ts`): in chat, their own turns in the conversation; in an
  agent run, the input when a person submitted it through `POST /api/agents/runs` or `/runs/batch`
  (`agent_runs.input_from_requester`), recomputed on every attempt. A run a plugin or an event
  started, and a `streamChat` turn, carry none. A tool that fetches the web reads a URL only when
  it is in this set or its own search returned it, so text from a page, a document, an email or
  the model cannot point it somewhere the person never asked for.
- **A streamed chat turn (`streamChat`)**: `streamChat(c, { promptKey, feature, message, history?,
  system?, variables?, tools?, maxTurns?, signal?, threadId?, onFinish? })` from `@/plugins/api` is
  a plugin route's whole answer — the kit's resolve seam, streaming tool loop, AG-UI encoder (SSE or
  protobuf), GenAI trace and `recordUsage`, with none of chat's conversation rows. `promptKey` must
  be one the plugin registered in `ServerPlugin.prompts` (`promptOwner`), and that plugin's id is
  the namespace: `feature` is `<id>`, `<id>:…` or `<id>.…`, and `emit(name, value)` — on the tool
  context and in `onFinish(result, { emit })` — sends a CUSTOM event only when it is `<id>.…`
  (never `kit.`); any other name ends the run with `RUN_ERROR` `invalid_custom_event`. Tools are
  the plugin's own, built inside the stream on its database client; gated tools are withheld.
  Budgets are chat's: `AGENT_MAX_OUTPUT_TOKENS`, `maxTurns` clamped to `CHAT_MAX_TOOL_TURNS`,
  history trimmed to `CHAT_HISTORY_MAX_CHARS` (`kit.notice history_truncated`), not counted against
  `AGENT_TENANT_DAILY_COST_USD`. No provider is the JSON 503 before any frame. A plugin test drives
  it with `scriptPlatformChat` from `@testkit/integration` (§9).
- **Credentials**: a plugin stores a tenant's key with `sealSecret` / `openSecret` from
  `@/plugins/api`. That is the kit's AES-GCM under `OAUTH_ENCRYPTION_KEY`, with a 503 when the key
  is unset. Store the sealed value in a `*_enc` column and answer `hasCredential`.
- **Reserved paths**: `/mcp`, `/oauth` and the OAuth `.well-known` documents belong to core's MCP
  server (§19). A plugin claiming one as a mount, an `apiPrefixes` entry or a public mount stops
  the app at load (`assertNoReservedPluginPaths`), naming the plugin, and `pnpm plugin check` fails
  it first (an `apiPrefixes` entry in the manifest, a `['/mcp', …]` mount tuple in the source) — a
  plugin's MCP tools need no route of their own, only `tools`. The opt-in analytics plugin's own
  `/mcp` (drizzle-cube, API-key auth) is refused by this; its plugins release moves its cube tools
  onto `tools` and drops the mount and its vite `/mcp` proxy edit.
- **Public mounts (D34)**: `publicMounts` are routes a third party calls with no session — an
  admin-consent callback, a webhook. Only under `/api/hooks/<id>` (so no toml edit and one
  enumerable prefix per plugin), mounted before the authed table with no `authMiddleware` and no
  gate; `tests/config/plugins.test.ts` refuses one anywhere else and any authed mount there. The
  handler gets `publicCtx(c)` — no tenant, no auth fields, `enqueue`, `features(tenantId)` — and
  proves the caller before naming a tenant. `signState` / `verifyState` are the proof for a
  round-trip the plugin started: HMAC-SHA256 under a key HKDF-derived from
  `OAUTH_ENCRYPTION_KEY`, a `purpose` that is part of the signed body, an absolute expiry
  (default 10 min), `null` for every failure. Signed, not encrypted. The host guards every
  public mount before its router runs (`api/middleware/public-mounts.ts`): a per-IP KV sliding
  window in a bucket named after the prefix — default 120 / 60 s, `rateLimit: false` to opt out
  (a webhook sender with fixed IPs that batches), a no-op without `RATE_LIMIT_KV` like every kit
  limit — and the body cap, chosen at middleware step 5 before any parsing: 1 MB unless the
  mount declares `bodyLimitBytes` (≤ 10 MB; the config test refuses more), which then replaces
  it beneath that prefix for every content type, so a ~200 KB SAML form POST or a SCIM bulk body
  is neither refused nor unbounded. Both are the optional third tuple element,
  `[prefix, router, { rateLimit?, bodyLimitBytes? }]`; a path is throttled by the longest public
  prefix it falls under only.
- **Public sites**: `ServerPlugin.publicSites` serves whole hosts from a plugin's router, for
  anonymous readers. `hosts(config)` lists the hosts it answers (lowercase, no port); `null` means
  the plugin's config is bad and it is **dormant**, so every host other than `APP_URL`'s and
  loopback gets a plain, uncached 503. `api/middleware/public-sites.ts` runs after
  `databaseMiddleware` and before every mount, and reads the host from the request URL (no
  forwarded header is trusted). On a matching host the plugin's router answers everything, so
  `/api/*`, `/auth/*` and `/ws` are never reached there. GET and HEAD are allowed, plus POST on a
  path declared in `forms`; anything else is 405. The order is cache lookup, router, cache put. Page
  requests are never rate limited (a form POST is). The cache key is `<host>/<deployment>/<generation>/<path>`, without the query string:
  the deployment is `DEPLOYMENT_ID` (set uniquely by the deploy scripts and CI with `--var`,
  else `RELEASE_VERSION`; under `wrangler dev`, one id per boot), so new rendering code is never hidden behind a page an older
  deploy stored. `cache` is optional, and its `generation` must not touch Postgres, so a hit costs
  no query; it returns null to skip caching a request. `generationMaxAgeSeconds` (default 0, a
  number or a function of the config) lets one isolate reuse the last generation for that long and
  then serve it once more while a fresh read runs in `waitUntil` (up to 30× the age; older is
  awaited): the generation read leaves the hot path, and a publish shows within about that window. A cacheable request reaches the router without `Cookie` or `Authorization`, so a cached site is anonymous. Only a 200 with no `Set-Cookie`, and with no `Vary` beyond `Accept-Encoding` and the `cache.variantHeaders` of a request that has a variant, is stored, and HEAD is
  served from the GET entry. A form POST bypasses the cache and has its own body limit (default
  64 KiB, at most `MAX_PUBLIC_MOUNT_BODY_BYTES`) and rate-limit bucket. Two plugins claiming one
  host, or a claim on `APP_URL`'s host, fail the gate (`publicSiteIssues`); at runtime the claim is
  ignored and logged. A site host always gets the strict public CSP from
  `api/middleware/security-headers.ts`, on hits and misses alike: no script, frame, connection or
  form target unless `csp(host, config, pathname)` declares one (`pathname` lets one path carry less
  than the rest of the host; a `connectSrc` or `formAction` path such as `/submit` is pinned to the
  request's origin, so one route opens rather than the host), `style-src <request origin>/site-assets/`
  (the same source joins `script-src` once a site declares any script, so a page cannot load the
  admin bundle from `/assets/*`; `publicSiteIssues` refuses a declared script source reaching that
  path, including `'self'`, and at runtime it is dropped) and
  `frame-ancestors 'none'`. Inline script stays banned: a declared source containing
  `'unsafe-inline'`, `'unsafe-eval'`, `*`, `data:` or `;` fails `publicSiteIssues` and is dropped at
  runtime.
- **The `publicSites` manifest field**: `"publicSites": { "hostsVar": "SITES_HOSTS" }` in
  `rocketflare-plugin.json` names a var holding a comma-separated list of `host` or `host=anything`.
  Its presence is what makes `pnpm provision` write `run_worker_first = ["/*", "!/assets/*",
  "!/site-assets/*"]`, `not_found_handling = "none"` and one route per declared host beside the
  app's, in both tomls. A missing file under either asset prefix is a plain 404; the SPA catch-all
  serves `index.html` for a navigation only. Without such a plugin both stay as
  they were. `plugin add` writes both values and keeps the previous lines in marked
  comments. When `plugin remove`, or an `upgrade` whose release drops `publicSites`, puts those lines
  back without API prefixes provisioned since, it marks the list `# rocketflare:reprovision` and prints
  a re-provision step; `plugin check` fails while a marked list lacks a plugin's prefixes, and
  `provision cloudflare` clears the mark. The `images` binding type is declared in the toml and has no resource to create.
- **`appOwned` paths** (`"appOwned": ["apps/web/src/plugins/<id>/app"]`, inside `paths`): the developer's. `plugin upgrade` never touches them, and `plugin remove` lists a file changed or added since the pinned commit and needs `--force-app-owned` to delete it.
- **`workspace` route tier**: a `UiPlugin` route with `tier: 'workspace'` renders inside `Layout`,
  in the shell's route table, for a page that needs the whole space under the app header (an
  editor canvas). It requires sign-in and a tenant, and its `guard` is honoured, as on `shell`. On a
  workspace route from `lg` up the sidebar collapses to its icon rail whatever the reader saved,
  the saved preference is untouched and returns on leaving, and the collapse toggle is hidden;
  below `lg` the drawer is unchanged. `<main>` has no padding and the page fills the viewport under
  the 56 px header (`h-full` in a plugin page), scrolling only its own panes. The other tiers are
  `shell` (the default), `noTenant` and `public`.
- **Header items (`UiPlugin.header`)**: `{ id, Component, guard?, order?, placement? }[]` adds
  controls to the top bar — `placement: 'center'` (a search box, in `Layout`'s `headerCenter`) or
  `'end'` (the default, ahead of the kit's status, bell and user menu). `App.tsx` renders them with
  `PluginHeaderSlot` for every shell and workspace page, ordered by `order`, then plugin id, then
  item id; each behind its guard (the same `useNavGuard` semantics as nav and routes), inside its
  own `Suspense` and error boundary, so a slow or throwing item renders nothing and the shell
  stands. `Component` is `lazy(() => import(...))` like a page. The host reserves no width and
  collapses nothing on a narrow screen: an item is a compact control and opens anything large as
  its own lazy chunk. `headerItemIssues` (`plugins.test.ts`) refuses a duplicate id or an unknown
  placement.
- **Destinations (`useNavigationEntries()`)**, from `@/plugins/api/ui`: every place the reader may
  open as one flat list of `{ id, label, to, group, icon?, keywords?, source }` — the side nav as
  `SideNav` composes it (`composeNav` over `CORE_NAVIGATION` and every plugin's `nav`), the
  `/settings?tab=` tabs (the core list in `pages/settings/tabs.ts`, which `SettingsLayout` renders,
  plus every plugin's `settingsTabs({ can })`, all behind the page's `admin`), and the Home quick
  links (plugins' `homeLinks`, then the core ones). Each is filtered by `useNavGuard`, the first
  entry for a path wins, and `source` is `kit` or the contributing plugin's id. It is what a
  command palette searches; `navigationEntries(plugins, checks)` is the pure half.
- **UI registries (`UiPlugin.extensions`)**: the browser twin of `ServerPlugin.extensions` — plain
  data under a key the OWNING plugin names (`global-search.commands`), read with `uiExtensions(key)`
  (and `uiExtensionSources(key)` for the error message) from `@/plugins/api/ui` and narrowed by
  that owner's schema. It ships in the main bundle with the UI entry, so data only.
- **`listAgents()`** from `@/plugins/api`: every registered agent (the kit's and each plugin's) as
  `{ key, title, description }` — the catalogue `GET /api/agents` serves, for a plugin that lists
  or searches agents. Loaded at call time, off the API's load path; the caller applies the guard
  (`read AgentRun`).
- **`resolveOwnerTenant(db, config, ownerSlug?)`** from `@/plugins/api` finds the tenant that owns a
  public surface: `getSingleTenant` under `single`, by slug under `multi`. It returns null for a
  missing slug under `multi`, an unknown slug, and any tenant whose `status` is not `active`. This
  and the plugin's config parser are the only places a plugin should branch on `TENANCY_MODE`.
  **Known gap:** under `multi` it matches a slug, and a slug can be renamed or reused, so a tenant
  that renames or is deleted frees a public host for whoever registers that slug next. Bind by id
  before tenants can own public sites themselves.
- **Identity (the identity seam)**: a public handler that has proved a person signs them in with
  `identityFor(c, id).signIn(...)` — the kit links, admits, applies an `idp` membership and mints
  the session (§2) and the plugin returns the redirect it answers; it never touches
  `user_sessions`, cookies or `tenant_users`. **Linking by email is opt-in — decided:** a sign-in
  (or `upsertUser`) whose email belongs to an account with no link from this plugin is refused
  (`account_exists`) unless it passes `linkByEmail: true`, which a plugin sets only when it has
  proved its IdP owns the email's domain (a DNS-verified domain on the connection) — a per-tenant
  IdP can assert any address, so linking by email alone would let one customer's IdP sign in as
  anyone. **A subject with no link also needs it to CREATE an account**, with the same
  `account_exists` either way: otherwise the IdP could reserve an address before its owner arrives
  and keep a working link to the account they sign in to. A `BOOTSTRAP_ADMIN_EMAILS` address is
  never created or linked through the seam (admission's `proof: 'plugin'` never earns the platform
  role either); the operator signs in with a kit method. A suspended tenant is refused on every
  tenant-taking method: 403 `tenant_suspended`, and `signIn` naming it answers `no_access`. `provisionFor(ctx, id)` is the cookie-free half, from
  any `PluginContext` (SCIM, a directory sync): `findUser`, `upsertUser` (creates with a link and
  no session; a block stays; an unverified email never links to an existing account),
  `setMembership` / `removeMembership` (`source = 'idp'` only, so read-only in the app — 409
  `idp_managed` — and never an owner, support or manual row), `deprovision` and `listMembers`.
  **`removeMembership` is the membership only** (the IdP stopped granting the tenant: its sessions
  are UNPINNED and fall back to another membership); **`deprovision` is a leaver** (SCIM
  `active: false`): the same removal plus DELETING the sessions pinned to that tenant, answering
  `{ removed, sessionsEnded, retained }` — `retained` is a manual/owner/support row it left, with
  its sessions — and `blocked`. **Decided: never global in multi mode** — no `blocked_at`, no
  other tenant's sessions or memberships, because a tenant's IdP speaks for that tenant only; the
  person's API keys in that tenant stop authenticating because `validateApiKey` joins the
  creator's membership there (401). **Decided: in single mode `deprovision` BLOCKS** — the one
  tenant is the deployment, so the multi-mode reason (the person's other tenants) does not exist,
  and without a block a magic link, Google, another plugin's sign-in, dev login's `onNoTenant` or
  the session left with no pinned tenant would let the leaver straight back in. It sets
  `users.blocked_at` with `blocked_source = 'plugin:<id>'` and deletes EVERY session (keys answer
  403 `blocked`), answering `blocked: true` — only for a person the IdP speaks for (it just
  removed their `idp` row, or they carry this plugin's link), never with a `retained` row, and
  never a global or bootstrap admin (logged: no IdP locks the operator out). The block has a
  source so reactivation cannot undo an operator: the SAME plugin's `setMembership` (SCIM
  `active: true`, a role again) lifts a `plugin:<id>` block and nothing else; the admin console's
  Block writes `manual` (and takes over an IdP block), Unblock clears either, NULL means manual;
  `upsertUser` and `signIn` never lift one. A tombstone `onNoTenant` checks was rejected: it would
  close one door of six, where `blocked_at` is already checked by every sign-in, the session
  middleware and API keys. In single mode every tenant-taking method also accepts only THE tenant
  (`getSingleTenant`), `tests/api/tenancy-single-identity.test.ts` proves the mode end to end.
  `tests/driver/identity.test.ts` runs sign-in, provisioning and the single-mode block under both
  drivers. Every tenant-taking method 404s a missing tenant; the CALLER must have proved its right
  to that tenant, the `PublicCtx` contract. `loginMethods(cfg)` contributes login-page buttons whose `startPath`
  must sit under `/api/hooks/<id>/`, and whose `errors` copy is keyed `<id>.<name>` —
  `plugins.test.ts` fails a stray one, and `GET /auth/methods` drops it with a log. `example-feature`'s dev-only `/api/hooks/example-feature/sso/*` is the
  worked example.
- **SSO required (`ssoPolicy`)**: `(db, email, { config }) => Promise<{ required: true; methodId;
  label?; connectionId? } | null>` — "my connection claims this email's domain; send them to my login method
  `methodId`". The host asks every plugin once per sign-in attempt and enforces the answer on all
  of its own methods and on every OTHER plugin's `signIn` (§2); `evaluateSsoPolicy` is pure over
  the plugin list and `plugins.test.ts` drives it with fixtures (claim, other plugin, throw,
  malformed answer, undeclared method, break-glass). Keep it to one indexed lookup on the domain,
  answer `null` for a domain no connection claims, and let a real failure throw (the host fails
  closed). The host does not verify the domain, end existing sessions or check `provisionFor`.
  `example-feature/api/sso-policy.ts` claims `@sso-required.example.test`, development only.
- **Inbound email**: `emailHandlers` route Cloudflare Email Routing mail ("Send to a Worker") to
  a plugin by the recipient's LOCAL PART — `receipts` takes `receipts@…` and `receipts+tag@…`, `*`
  is the catch-all — through the Worker's `email` export (`api/email.ts`). The host validates
  config, opens one DB client, `setReject`s an address nobody claims and rethrows a handler's
  failure (a temporary failure the sender retries, never a bounce). The handler gets `emailCtx` —
  `CronCtx`'s shape, no tenant: an address is not an organisation — and owns MIME parsing, sender
  checks, tenant resolution and storage; it should store, write a row and enqueue. Routing an
  address to the Worker is a per-zone dashboard step. `plugins.test.ts` refuses two plugins
  claiming one local part.
- **A callback completing a signed flow**: `verifyState` proves who minted the state and when, not
  that they still may. `memberCan(ctx, { tenantId, userId }, action, subject)` from `@/plugins/api`
  re-reads the membership, role, account block and tenant status now; a public callback calls it
  right after `verifyState`, with the action and subject the start route guarded.
- **Background feature checks (D34)**: `JobCtx`, `CronCtx`, `PublicCtx` and `EmailCtx` carry
  `storage()` (R2 under `tenants/<id>/<plugin id>/…`, purged with the tenant) and `features(tenantId)` — the same resolution as `auth.features`, with no user, so a cron that fans
  out across tenants can skip the ones whose flag is off. `AgentCtx` and `ToolCtx` carry the same
  `storage()` (one `filesStorage(env)` behind every context's), keyed under the run's tenant.
- **Starting agent runs from the background**: the same four contexts carry
  `startAgentRun({ agentKey, tenantId, input, idempotencyKey?, concurrencyKey?, triggeredBy? })`
  → `{ runId, status, deduplicated }` — `POST /api/agents/runs` without a request, through the
  same `enqueueRun` (validation, exclusive slot, active-run cap, daily budget, the Workflow start;
  each refusal a throw, so a job retries). A job passes an `idempotencyKey` naming the WORK
  (`receipt:<documentId>`), so a redelivery answers the first run instead of starting a second
  (§9). `triggeredBy` is the requester whose access the run's tools read; omitted, a system run.
  It is part of `feature-agents` and reaches the runtime by a function-scope import (the agent
  registry reads the plugin barrel). `@testkit/unit`'s `makeJobCtx` / `makeCronCtx` /
  `makeEmailCtx` record every call in `startedRuns` and take a `startAgentRun` replacement.
- **Plugin events (D42)**: "something happened in a plugin" as a declared, durable, tenant-scoped
  fact — the way an inbound email is something that happened outside. **Declare** in the shared
  entry, `events: { '<id>.<thing>.<happened>': zodSchema }` (never `kit.`; listed in `plugin.json`
  `"events"`; `plugins.test.ts` and `plugin check` refuse a mis-prefixed, colliding or undeclared
  name), so `EventName` / `EventPayload<E>` are derived types. **Emit** with `ctx.emit(name,
  { payload, idempotencyKey? })` on `RequestCtx`, `AgentCtx` and `EventCtx` (tenant-bound), or
  `{ tenantId, payload, … }` on `JobCtx`, `CronCtx`, `PublicCtx` and `EmailCtx`: it validates the
  payload (400), writes one `plugin_events` row (deduplicated per `(tenant, name, key)`; an emit
  that recorded but never queued is re-queued by the same key), then queues ONE `event.deliver`
  job per subscriber carrying ids only — it never runs a handler. The payload is kept
  `EVENTS_RETENTION_DAYS` (7, the nightly `pruneEvents` task), purged with the tenant, re-read and
  re-validated under the tenant predicate on delivery, and never logged. **Subscribe** with
  `ServerPlugin.eventHandlers: [{ event, name, handle(event, ctx) }]` (adapt with `eventCtx(ctx)`:
  tenant-bound `emit`, `enqueue`, `nudge`, `features()`, `storage()`, `startAgentRun`,
  `startBoundAgent`) or, for a copy's own code, `APP_EVENT_HANDLERS` in
  `apps/web/src/api/services/events/app-handlers.ts` (app-owned: `kit:upgrade` never ports it).
  A throw retries that subscriber alone (the jobs backoff); a 4xx `ApiError` is logged and acked.
  **Agent triggers**: `AgentDefinition.triggers: [eventTrigger(event, { where?, input })]` starts
  a run per matching event through `enqueueRun` (input schema, exclusive slot, active-run cap,
  daily budget), idempotent per (event, agent) via the run key `event:<eventId>`; the run records
  `trigger_event` / `trigger_event_id`, the runs page and run page show the event, and the
  `agent_run.requested` activity row says `via: 'event'`. **Bindable agents** (a no-code "On
  submit, start" picker): an agent opts in with `bindable: [eventBinding(event, { input })]`;
  `GET /api/agents/bindable?event=` (any member) and `listBindableAgents(event)` list them;
  `EventCtx.startBoundAgent(key)` starts one for the DELIVERED event and re-checks the opt-in on
  the server — an unknown key, a plain agent and a merely triggered one are all 403
  `agent_not_bindable`, so a forged key starts nothing. `@testkit/integration`'s
  `deliverEvents(env, db)` runs the queued deliveries through the real consumer. Worked example:
  `example-feature` (`POST /notes` emits `example-feature.note.created`, `events/note-created.ts`
  audits it, `agents/note-stats.ts` is triggered unless the title starts "draft", and bindable).
- **Knowledge ingest (D34)**: `ingestDocument` / `ingestDocumentFile` / `deleteIngestedDocument`
  over the kit's ingest paths (§9). With an `externalId`, the same `(tenant, source, externalId)`
  UPDATES the row — text, owner, visibility, grants, chunks, the stored original — so a sync can
  replay safely. Group ids are checked against the tenant first. A plugin's document is
  `origin: 'integration'` — the weakest trust for the facts read from it (D43) — and an optional
  `reviewerUserId` (the person who connected the source) reviews those facts. This file belongs to the
  `feature-knowledge` surface; a plugin that ingests requires it.
- **Platform knowledge**: `ingestPlatformDocument(ctx, { source, externalId, title, text })` /
  `prunePlatformDocuments(ctx, { source, keepExternalIds })` write the tenant-less corpus (§9).
  They take ONLY `JobCtx | CronCtx`, which now carry `kind: 'job' | 'cron'`, so the structurally
  identical `EmailCtx` and `PublicCtx` are a type error, and they check at run time too. The
  `source` must be `<installed plugin id>:<kind>` (never `kit:`). Ingest embeds synchronously with
  the platform embedder, throws `PlatformEmbeddingsError` (503) with nothing written when there is
  none, and returns `unchanged` for the same title and text. `searchKnowledge(ctx, { query, limit,
  sources?, platformSources?, signal? })` → `{ hits, semantic }` works from any context with a
  `scope` and falls back to keyword search. `ServerPlugin.knowledgeSources?(scope)` adds platform
  sources to the kit's `search_knowledge` tool (unioned; an unnamespaced source is dropped, a throw
  skipped). `fuseByRank` / `anyTermTsquery` / `candidatePoolSize` are exported for a plugin's own
  corpus. **Never put tenant data in a platform document**: every organisation can read it.
- **Knowledge entity types** (D43, §9): `ServerPlugin.knowledgeEntityTypes` is a list of
  `EntityTypeRegistration`s (`@/plugins/api`) whose rows extraction may attach facts to — a FIELD
  on the plugin contract, not a barrel, so the seam is still six barrel lines. Each `type` is
  `<plugin id>.<name>`; `table` is optional and, when given, one of the plugin's own tables with
  `labelColumn` for the kit's trigram resolver (`defaultEntityResolver`, exported so a plugin's
  own `resolve` can wrap it) or a `resolve` that filters by `scope.access.tenantId`.
  `knowledgeEntityTypes()` composes the app's and every plugin's and throws on a bad one; the
  config test runs it over the installed set. A fact is never written into a plugin's column.
- **Skills**: a plugin ships agent skills at `skills/<dir>/` in its own tree and declares them in
  `"skills"`; `add` copies each to `.claude/skills/<dir>/` (the one place outside its roots a
  plugin may write) and records it on the surface, `upgrade` REPLACES it (never patches — an agent's
  instructions are the plugin's outright), `remove` deletes it. `<dir>` is `<id>` or `<id>-*` and
  its SKILL.md `name:` equals it, so a plugin skill can never shadow a kit `rf-*` one; an existing
  directory is a refusal. `plugin check` fails a declared skill that is missing, misnamed or
  undescribed, and a directory in the plugin's namespace it does not declare. `.claude/` in a
  plugin repository stays that repository's own tooling. `example-feature` ships one.
- **Claude Code hooks** (`claudeHooks`): `{ "<Event>": [{ command, matcher?, timeout? }] }`, merged
  by `add` into the host's `.claude/settings.json` (created if absent) as one matcher group per hook
  at the end of its event; `upgrade` replaces them and `remove` takes out exactly them, so a round
  trip is byte-identical (and deletes a file `add` created). The command may only be
  `node "$CLAUDE_PROJECT_DIR/.claude/skills/<dir>/<script>"` plus plain flags, over a script one of
  its declared skills ships: a hook runs in the developer's coding agent, so it can run nothing the
  plugin does not ship and `remove` does not delete. That skill directory is also what identifies
  the plugin's entries (the longer id wins on a shared prefix). `plugin check` fails a declared hook
  missing from the file, an undeclared one in the plugin's namespace and a missing script.
  **Known gap:** `.claude/settings.json` is `manual` in `.rocketflare.json`, so a kit release
  changing the kit's own hooks reaches a copy as a hand merge, as before.
- **Host files** (`hostFiles`): `[{ path, from }]`, a file or directory the plugin SEEDS for the
  developer under `docs/<id>/`, `apps/web/public/<id>/` or `apps/web/src/host/<id>/` (nowhere
  else). `add` copies only what is absent; `upgrade` never touches one, and seeds only an entry the
  release adds; `remove` leaves them and lists them. The surface records them in `hostFiles`,
  outside `paths`, so the kit's file classification knows whose they are and `remove` deletes none.
  A plugin imports its own `apps/web/src/host/<id>/` as `@/host/<id>/…` (the existing `@/*` alias),
  and only its own id's (`tests/helpers/plugins.ts`). **Known gap:** `plugin export` does not write
  host files back to `from` — they are the app's content, not the plugin's.
- **Hooks** (`onTenantCreated`, `onTenantDeleted`, `onTenantStatusChanged`, `seedDemo`) run
  post-commit, are idempotent, and are try/caught. DO state is purgeable only through instance
  names **derived** from the tenant id. `onTenantStatusChanged(db, tenantId, status, env)` runs
  after a global admin suspends (`'suspended'`) or reactivates (`'active'`) a tenant, from
  `setTenantSuspended` (`runTenantStatusChangedHooks`), each failure logged as a warning and
  swallowed: it is how a plugin that caches or publishes a tenant's content outside the auth
  middleware's reach (a public page, an edge cache) stops serving it.
- **Traps measured, now rules**: registries a plugin composes into are FUNCTIONS, not consts
  (module-evaluation order); a value a plugin needs moves to a leaf module; browser-read registries
  are separate files from composing ones; plugins declare `relations()` for their own tables only
  (drizzle type intersection); annotate `const ctx: RequestCtx` so `never` narrows.
- **`example-feature`** is the vendored reference that exercises every slot. It exists to be
  deleted.

**D31 decisions** (cited by number in code comments):

| # | Choice |
|---|---|
| 1 | First-party only; the install plan waits for a human |
| 2 | The kit is bare; `defaultPlugins` + a bootstrap step install an app's own set on its fresh clones (empty in the kit: analytics is opt-in) |
| 3 | `example-feature` is the reference plugin |
| 4 | A plugin is recorded as a `kind: 'plugin'` surface; `readManifest()` is the one kit-vs-app predicate |
| 5 | Compatibility is proved in CI from both ends (`kit.yml` with `defaultPlugins` + `ci-plugins.json` installed; `plugin-ci.yml`; `kit:release` refusal) |
| 5b | *(reversed)* a `PLUGIN_API` integer beside `requires.kit` |
| 5c | Compatibility is observed: derived `uses` against the emitted ledger, plus a `minKit` floor |
| 6 | Cubes/fact tables/dashboards are plugin-owned registries via `extensions`, narrowed by the owner |
| 7 | Analytics extracted with no compatibility path (tables become `analytics_*`) |
| 8 | Pages are `lazy()`, proved by a source-level test |
| 9 | Four published entries; deep imports fail in either direction |
| 10 | Phase A shipped as four PRs, one release |
| 11 | Uninstall drops tables by default, `--archive` on request |
| 12 | Provisioning writes plugin bindings into both tomls (`kv`/`queue`/`r2` created; `workflow`/`durable_object`/`images` declared) |
| 13 | Every manifest has a required `repo` |
| 14 | The inbound surface is injected context (the `*Ctx` family), not imported symbols |
| 15 | What cannot be injected is a declared entry (`@/db/schema/kit`, split UI kit, `@testkit/*`) |
| 16 | A printed instruction is not a mechanism — hence the worker-exports barrel |
| 17 | DO migration tags are append-only and host-owned |
| 18 | Out-of-Postgres tenant state is purged via `onTenantDeleted` over derived DO names |
| 19 | Test builders refuse a fake database |
| 20 | Every plan step is declarative, agent or human (`kind` in `--json`) |
| 21 | `plugin check` is an exhaustive, untiered oracle that reads comment-free code |
| 22 | Table prefixes are convention; collisions are the check |
| 23 | A plugin ships agent skills: `skills/<dir>/` → `.claude/skills/<dir>/`, namespaced by id, replaced on upgrade |
| 24 | Inbound email is a slot keyed by local part; the host dispatches and rejects, the plugin parses, authenticates and stores |
| 25 | A background context starts an agent run through the route's own `enqueueRun`; idempotency is a derived run id, not a new column |
| 26 | Plugin identity is `identityFor(c, id)` / `provisionFor(ctx, id)`, links under `plugin:<id>`, memberships through the core `idp` primitives; login buttons are declared, never rendered by the plugin |

**D42 decisions** (plugin events and agent triggers):

| # | Choice |
|---|---|
| 1 | Events are declared in the shared entry (zod), namespaced `<id>.`, never `kit.`; the registry is server-side, derived from the shared barrel |
| 2 | Emit records then queues; one delivery job per subscriber, ids only; the payload lives in `plugin_events` for `EVENTS_RETENTION_DAYS` |
| 3 | Emit on a tenant-bound context takes no `tenantId`; only the background contexts name it |
| 4 | A trigger and a binding start through `enqueueRun` with the key `event:<eventId>` — at most one run per (event, agent) |
| 5 | `triggeredBy` stays a person; the event is its own two columns on `agent_runs` |
| 6 | A bound start is a method on the DELIVERED event's context, so neither the event nor its tenant can be forged, and the opt-in is re-checked there |
| 7 | A subscriber's 4xx refusal is acked; anything else retries that subscriber only |

**Plugin events known gaps (D42):** an app cannot DECLARE events of its own (it only subscribes,
through `APP_EVENT_HANDLERS`); emit is not transactional with the caller's write (emit after the
row is stored, with a key naming it); a binding has no `where`; there is no event log UI and no
replay of a pruned event; subscribers run in queue order, with no ordering guarantee between
events.

**Known gaps:** no sandbox, review or signing; no rename migrations (expand/contract only); no
cross-plugin FK tooling or `many()` onto core tables; `grants` is additive by convention only;
provisioning never deletes resources and never creates an Email Routing rule; `d1`/`vectorize`/`analytics_engine` bindings are refused;
the ledger judges only ledgered entries, ignores namespace imports, truncates types over 300
chars, and `uses` is only as fresh as the last export; table collisions are caught by `check`, not
refused at `add`; the isolation check proves a test exists, not that it is right; no database-free
test of data-touching handlers; one DO per row is unpurgeable (purge-intent ledger not built);
`plugin-ci.yml` input changes reach callers only via `main`, and nothing tests versions between
floor and ceiling. `addedDependencies` starts after 0.17.1: a plugin installed by 0.17.1 or earlier has its
older packages kept, never removed, when a release drops them, and a package a plugin added that
the kit later starts declaring too is still the plugin's to remove. Public mounts (D34) have no `@testkit` builder
(test them through `request()`), and their rate limit is the kit's approximate KV window, keyed
on the client IP — a sender behind a shared egress shares one bucket; `verifyState` has no replay ledger — a token is reusable until it
expires, so a plugin whose callback must run once records that itself; an ingested document's
upsert reads the previous row before writing, so two racing re-ingests of a FILE may leave one
replaced original behind in R2; a plugin skill edited in place is overwritten by the next
`plugin upgrade` (copy it to a skill of your own first), and `check` validates a skill's name and
description, not what it says — a stale command in a SKILL.md is caught only by reading it.
`startAgentRun`'s `idempotencyKey` is forever per (tenant, agent, key) — there is no expiry, so a
plugin that wants to re-run the same work later must vary the key; `RequestCtx` has no
`startAgentRun` (a route calls `POST /api/agents/runs`, or enqueues a job that does). `streamChat` stores no turn (the plugin owns
its history and sends it back), has no feedback thumbs (its STATE_SNAPSHOT says `feedback: false`),
no summary of a trimmed history and no daily cost cap; a CUSTOM name a TOOL refuses still reaches
the model as that tool's error result before the run ends. Header items get no overflow menu: on a
narrow screen each plugin keeps its own control compact.

---

## 17. Connectors

An **organisation connection** to Microsoft 365 or Google Workspace (D34): an org admin grants an
operator-registered app access to the whole directory, calendars and — later — mail and files, and
Rocketflare syncs them into the tenant. It is **not login** (§2): a different app, a different
grant (admin consent / domain-wide delegation, app-only tokens), a different subject (the
organisation, not the signer). The design, operator and customer-admin setup, phases and the MCP
assessment are in `docs/CONNECTORS.md`.

It ships as plugins, not core: the `connectors` base plugin (installations, connections, sync
cursors, the settings tab, the sync job and cron) and one provider plugin each (`m365` first,
`google-workspace` next), registered through `extensions.connectorProviders`. The kit's part is
four generic seams on the plugin surface (§16): public mounts at `/api/hooks/<id>`, `signState` /
`verifyState`, `ingestDocument` with an `externalId` upsert (§9), and `features(tenantId)` off the
request.

| # | Choice |
|---|---|
| 1 | Login and connection stay separate apps, even in production |
| 2 | One operator-registered app per deployment by default; a per-customer BYO app is the escape hatch |
| 3 | The data model covers all three usage models from day one: installation → connection with `ownerType` `tenant` or `user` |
| 4 | Org-wide app-only ships first; per-user delegated is phase 4 |
| 5 | Directory + calendar by delta polling first — no restricted scopes, so no Google CASA gate |
| 6 | Webhooks only ever trigger a delta fetch; polling stays the backstop |
| 7 | Every synced row carries its owner; tenant isolation alone is not enough inside one organisation |
| 8 | Vendor MCP servers are not a data plane (delegated only, no delta or webhooks) — at most a later chat-tool adapter |

**Known gaps:** no webhooks yet (phase 2); no mail or file ingestion (phase 3); no per-user
delegated connections or refresh-token rotation (phase 4); Google Workspace provider not built;
M365 uses a client secret, not a certificate assertion; no Exchange RBAC-for-Applications scoping
script; synced private rows are still readable by tenant admins (D29 owner-and-admins); the kit has
no MCP client; directory sync does not provision kit users or groups (it only matches by email).

TypeSafe (Jev) is NOT a connector in this sense: it answers questions rather than syncing an
organisation's data, so it is an AI provider in the `decisions` scope (§9, D37).

## 18. Security testing

**A security finding counts only when a test proves it, and stays outside the repository until its
fix has released.** `/rf-security` (`.claude/skills/rf-security/`) is a multi-agent audit built on
Cloudflare's vendored security-audit skill, run against `docs/THREAT-MODEL.md`. How to run it, what
it costs and how to read it: `docs/SECURITY-AUDIT.md`.

- **Modes**: `quick` (16 agent calls), `standard` (50; usually diff-scoped, `<ref>..<ref>`), `deep`
  (90). An agent call costs about $2.00–2.50, so roughly $35, $110–150 and $200+. A coding agent
  runs it only when asked, after agreeing the budget.
- **Independence**: hunters work alone on narrow units and never see a suspect list; one fresh
  verifier per candidate, on a different model from the hunters; a critic over the coverage
  ledger; Phase 5 reviewers; a fresh verifier again after a material review. Confirmed means a
  vitest proof that fails on untouched code.
- **The runner** (`tools/audit.mjs`) does every mechanical step: run directories, budgets, briefs,
  ledger updates through upstream's validators (a step that does not validate leaves
  `*.next.json` and blocks the next), citations, reports and measured cost. Its tests are synthetic
  fixtures in `apps/web/tests/config/rf-security/`.
- **Isolation**: proofs run only in the sandbox (`pnpm security:sandbox`: an image from `git
  archive`, its own Postgres on an internal network, a read-only root, no capabilities). While a
  run is active the guard hook in `.claude/settings.json` refuses deletes, moves, credential reads
  and writes outside the run directory for every agent, and a snapshot around each wave stops the
  run if anything else changed.
- **Privacy**: runs live in `~/.rocketflare/security-runs/<app>/run-N`. A public report carries
  counts only, never an individual issue: `audit.mjs public-report` renders it from a hand-curated
  file of counts by run, release and severity (fixed issues only), refuses any field that could
  describe an issue, and never reads a run's findings.
- **Cadence**: a diff-scoped `standard` run before a release touching auth, tenancy/RLS, the
  identity or plugin seams, or AI tool binding (the kit's `kit:release` warns, never fails,
  `AUDIT_CADENCE_GLOBS` in `scripts/release.mjs`); a quarterly `deep` run. A fixed finding's proof
  becomes a regression test in `apps/web/tests/api/security/`.

**Known gaps:** no scheduled or CI audit; proofs run locally only, under Node rather than workerd,
so runtime- and browser-specific behaviour needs a separate local check; it needs Docker and a
model budget; one run finds about half of what is there, so a clean area proves nothing; the guard
is a Claude Code hook, so it binds only agents run through Claude Code in this checkout; the
public report's counts are typed by hand, so nothing checks them against the runs.

## 19. MCP server

**An AI client connects to the app at `/mcp` and acts as one person in one organisation, with that
person's permissions and nothing more.** Clients are those that identify themselves with an OAuth
Client ID Metadata Document — Claude (claude.ai, Desktop, Code) and ChatGPT. Plan and decisions:
`docs/plans/mcp-server.md` (kit repository). The `rf-mcp` skill drives turning it on, adding a
tool and connecting a client; `.claude/rules/tools.md` is the checklist for a safe tool, and
`apps/web/src/api/services/mcp/CLAUDE.md` maps the code and its invariants.

- **Deployment gate**: the environment-gated `mcp` flag (§15). Without `mcp` in `FEATURES_ENABLED`,
  `/mcp`, `/oauth/*`, the OAuth `.well-known` documents, `/api/mcp/*` and `/api/mcp-connections`
  answer 404. Each organisation's owners and admins then
  turn it on at Settings → MCP (`mcp_settings.enabled`, off by default).
- **Transport** (`routes/mcp.ts`, the official SDK's `createMcpHandler`): stateless Streamable
  HTTP, POST only (405 otherwise), both protocol eras (2026-07-28 and the 2025-11-25 `initialize`
  path), header/body agreement (-32020) from the SDK. Mounted before the mount table, outside the
  global CORS (its own: any origin, no credentials, `WWW-Authenticate` exposed) and outside
  `authMiddleware`. A browser `Origin` must be ours; none is fine. `capabilities.tools.listChanged`
  is false and a `subscriptions/listen` request is refused, so no request is held open. A JSON-RPC
  batch is refused (400, -32600) in both eras before the SDK sees it, so every call meets the
  limits one at a time. The global CORS skips these paths with or without one trailing slash.
- **Credential**: an OAuth access token (`mcpat_…`, one hour, SHA-256 at rest in `mcp_tokens`) of a
  live grant (`mcp_grants`: user, tenant, client, scopes, the exact URL it is for). Never a cookie,
  an API key or a CLI key. `/mcp/t/<slug>` is the same server pinned to one organisation, for a
  client that keys connectors by URL; a token is refused on any URL but its grant's.
- **The authorization server** (`services/mcp/authorization.ts`, `routes/oauth.ts`): the app is its
  own OAuth 2.1 server, in Postgres. Discovery: RFC 9728 protected-resource metadata for `/mcp` and
  every `/mcp/t/<slug>`, RFC 8414 metadata (also at `openid-configuration`) — S256 only, public
  clients only (`none`), `client_id_metadata_document_supported`, `iss` on every authorization
  response (RFC 9207), and no `registration_endpoint`. **Clients are their metadata document**
  (`services/mcp/cimd.ts`): `client_id` is an https URL on a public host and the default port; the
  fetch refuses redirects, takes ten seconds and 5 KB at most, needs a JSON type and a document
  naming its own URL; it is cached in `oauth_clients` for a day and a failed refetch fails. Every
  refusal of a fetched document reads the same on the page ("could not be used"), the specific
  cause only in the server log, so the page says nothing about what the URL reached. A document
  is cached only once it registers the request's `redirect_uri`, and the nightly `pruneMcp` drops a
  row unfetched for 30 days that no grant and no pending request names. A
  document must be usable as a public client: its `token_endpoint_auth_method` absent or `none`, or
  `none` among its `token_endpoint_auth_methods_supported` (ChatGPT prefers `private_key_jwt` and
  lists `none`, and falls back to it because our metadata offers nothing else); its `grant_types`
  and `response_types`, when present, must include `authorization_code` and `code`. The three v1
  clients' real documents are test fixtures (`tests/config/mcp-cimd.test.ts`). No DCR, no static
  clients. `GET /oauth/authorize` resolves the client and checks `redirect_uri` (exact;
  loopback any port) BEFORE anything is redirected — until then an error is a page on our origin;
  after it, the error goes back with `state` and `iss`. PKCE S256 is mandatory, `resource` must be
  one of our MCP URLs (`invalid_target`, also for a slug that does not decode), and the request waits ten minutes in `oauth_requests`.
  **Sign-in is the app's own `/login`** (a `returnUrl` to `/oauth/continue`), so every sign-in
  method, the single-sign-on policy, `SIGNUP_MODE` and blocking apply unchanged. **Consent** is the
  SPA page `/consent` (kit chrome, `frame-ancestors 'none'`): "<client> wants to use <APP_NAME> as
  you", the client's name and logo as CLAIMS beside the verified host of its `client_id` and the
  redirect host, a warning when it registers only loopback redirects, the organisations where
  `resolveMcpMember` admits the person (an `/mcp/t/<slug>` request offers only that one), the
  scopes and the tools. `POST /oauth/consent` (cookie + CSRF) re-checks it all, writes the grant
  (absolute end `MCP_GRANT_MAX_DAYS`, capped by `OIDC_SESSION_MAX_AGE_DAYS` under IdP-managed
  tenancy) and a code: SHA-256 at rest, sixty seconds, single-use — a second exchange revokes the
  grant. A live grant for the same client, organisation and URL that covers the asked scopes is
  remembered consent: no click. `POST /oauth/token` (form): `authorization_code` (PKCE verifier,
  client, redirect and resource must match) and `refresh_token`, which rotates every time; a spent
  refresh token presented again revokes the grant, **except** a retry within 30 seconds while its
  successor is unused, which gets the same pair back — sealed (AES-GCM) under a key derived from
  the spent token's own plaintext, so the database never holds an openable successor
  (`services/mcp/seal.ts`). `POST /oauth/revoke` (RFC 7009): a refresh token ends the connection,
  an access token itself; anything unknown is a silent 200. Rate limits: authorize, continue and
  consent take `authRateLimit`; token and revoke — called from the hosted clients' shared server
  IPs — take 600/min per IP plus 30/min per connection.
- **Lifecycle**: removing a member (by an admin or the IdP) revokes their grants there, and blocking
  someone (manually or by IdP deprovisioning) revokes all of theirs, in the same transaction
  (`revokeMcpGrantsOf`). Role, group and policy changes need nothing: every call re-reads them.
  Turning MCP off suspends connections (403) without revoking them.
- **Connections**: `/api/mcp/connections` lists the organisation's (`manage McpSettings`) with
  revoke and `POST /revoke-all`; `/api/mcp-connections` lists a person's own across organisations
  with revoke — account-wide, so a session only: an API key gets 403 `insufficient_scope`. Activity: `mcp.client_connected`, `mcp.client_revoked` (who, and why).
- **Who is calling** (`services/mcp/caller.ts`), re-read on every call, nothing cached on the grant:
  401 `invalid_token` with the RFC 9728 challenge when the TOKEN is the problem (unknown, expired,
  revoked, idle past `MCP_GRANT_IDLE_DAYS`, past `MCP_GRANT_MAX_DAYS`, another URL); 403 with a
  code when the PERSON is (`blocked`, `tenant_suspended`, `mcp_disabled`, `mcp_not_allowed` — not a
  member, a support role, outside "who can connect"). The `AuthContext` is built by the same
  `tenantAuthContext` as an API key's, with `isGlobalAdmin` forced false: a client acts as the
  membership, never with platform reach.
- **Tools**: `toolsFor('mcp', ctx)` from the caller's own access scope, CASL and features
  (`requesterUrls` empty — the client's model typed every argument), then the organisation's
  exposure: `read_only` (default — tools with no `sideEffects` and the read scope), `all`, or
  `selected`. A write tool is listed to a read-only token and answers 403 `insufficient_scope`
  naming `mcp:read mcp:write` (the step-up). An unexposed tool is "not found". Every result opens
  with a line saying it is data, not instructions, and is capped at 60 000 characters (a tool with
  an `outputSchema` whose answer is over the cap sends no `structuredContent` — it would carry the
  whole answer — and answers an error result with the capped text); `get_document` windows are
  20 000.
- **Limits and audit**: `MCP_CALLS_PER_GRANT_PER_MINUTE` (60), `MCP_CALLS_PER_USER_PER_MINUTE`
  (120 — one person across all their connections in the organisation, so no member can spend the
  organisation's minute alone) and `MCP_CALLS_PER_TENANT_PER_MINUTE` (600), checked in that order
  on the KV window, answered as tool errors (`rate_limited`), never 429. A limiter that cannot be
  read fails the call closed, as every limiter in the app does, but as a logged tool error
  (`tool_failed`) rather than a thrown request. Model spend is not MCP's: a tool that calls a
  model records it in `ai_usage` under that tool's own feature, as it does from chat, with nothing
  marking it as an MCP call, under the same tenant caps. `mcp_tool_calls`
  records each call — who, which connection, which tool, outcome, duration — never its arguments or
  result; kept `MCP_CALL_RETENTION_DAYS` (90) by the nightly `pruneMcp`, which also drops expired
  tokens. Each call is a `mcp <tool>` span with an `execute_tool` child.
- **Visibility is the HTTP routes'**: `tests/api/security/mcp-visibility.test.ts` proves a
  group-only document, its facts and its entities do not exist for an outsider through every core
  tool the server lists (a new core tool without a case fails it), and that each answer equals
  chat's for the same person.
- **Branding**: what a client sees is `APP_NAME` and the organisation's name — `serverInfo`, the
  instructions, the notice, every error. `mcp-server.test.ts` sets `APP_NAME="Acme Tools"` and bans
  `/rocketflare/i` from every response.

- **Settings → MCP** (`ui/pages/settings/Mcp.tsx`, the tab guarded by the `mcp` flag AND
  `manage McpSettings`): the switch; the server URL to paste — the organisation's
  `/mcp/t/<slug>` under multi-tenancy, `/mcp` under single — with setup snippets for Claude
  (claude.ai/Desktop connector, `claude mcp add --transport http <name> <url>`, the name slugified
  from `APP_NAME`) and ChatGPT; who can connect (everyone, admins, chosen groups); exposure (All
  read-only, Enable all after a confirmation, Selected with ticks); and the tools grouped Knowledge
  first then per plugin, each with its read-only/writes badge, annotations and 30-day call count,
  approval-gated and terminal tools greyed with the reason. The switch and the modes save at once;
  the group and tool ticks save as one list. Below them, **Connected clients**: every live
  connection in the organisation — the person, the client by the name its document claims and the
  host its `client_id` was verified on, read or read-and-write, connected, last used, 30-day calls
  — with Revoke and Revoke all, each after a confirmation.
- **Profile → Connected apps** (`ui/pages/Profile.tsx`, shown where the deployment ships `mcp` and
  the reader has at least one): the reader's own connections in every organisation, with Revoke.
  Both tables are `components/mcp/McpConnectionsTable.tsx`.
- A consent makes the grant, but it is a **connection** only once its code is redeemed
  (`mcp_grants.activated_at`, set by the first token exchange, which also records
  `mcp.client_connected`): an unredeemed grant is never listed or counted, and the nightly
  retention deletes it an hour after it was made.

**Known gaps:** only clients with a Client ID Metadata Document can connect (Claude, ChatGPT;
Cursor has DCR only, VS Code is untested) — no DCR, no static clients; a Worker cannot resolve DNS,
so a public name pointing at a private address is caught by the platform's egress, not by the
fetch guard; a call's own model spend is not attributed to it (`mcp_tool_calls.cost_microcents`
is always null, and its `ai_usage` rows carry no MCP tag; embeddings for search are unmetered as
everywhere else); a renamed organisation slug breaks grants
made on its `/mcp/t/<slug>` (the client reconnects); calls the SDK refuses before the handler (bad
arguments, an unknown tool) are not in the call log; ChatGPT cannot connect to local `wrangler dev`
(chatgpt.com answers workerd's metadata fetch with 403; deployed Workers are not refused); no
resources, prompts, approval tools or agents.
