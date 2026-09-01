# 01 — Authentication subsystem analysis

Sources compared:

- **Mirevue** (`~/work/mirevue`) — Hono + React on Node/Docker, `pg` driver, arctic, CASL. **Structural reference.**
- **GuideMode server** (`~/work/guidemode/apps/server`, "GM") — same lineage, runs on Cloudflare Workers (Hyperdrive→Neon, KV, Queues, Workflows, DOs). **Cloudflare substrate reference.**

Both codebases share a common ancestor: `sessions.ts`, `csrf.ts`, `token-crypto.ts`, `oauth-encryption.ts`, `helpers.ts`, the `oauth_providers`/`keys`/`user_sessions` schemas and the two-strategy `authMiddleware` are near-identical (`diff` on `token-crypto.ts` differs by one import suffix; `oauth-encryption.ts` differs only in Mirevue's key-derivation fallback). Mirevue is the later, cleaner fork; GM has the Workers plumbing plus a great deal of product-specific accretion (GitHub App, Jira/Linear/Notion integrations, Paddle billing, survey-only sessions, OSS corpus, CLI/desktop auth).

**Headline verdict:** take Mirevue's auth module as the base almost everywhere, then re-plumb three things from GM: (1) `c.env`-sourced config, (2) the single LATERAL-join session query + `waitUntil` fire-and-forget writes, (3) KV rate limiting and the `scheduled` cron hook. Strip both apps' product logic. The one structural incompatibility to decide up front is Mirevue's connection-pinned RLS (see Open Questions).

---

## 1. Request pipeline and context typing

### How auth attaches to Hono context

Both apps use identical global middleware order and identical `ContextVariableMap` augmentation:

- Mirevue: `security-headers → env → database → csrf → cors`, then routers; `/auth/*` is mounted *without* `authMiddleware`, protected routers get `app.use('/api/x/*', authMiddleware)` per mount — `mirevue/src/api/index.ts:65-132`.
- GM: same order — `guidemode/apps/server/src/api/index.ts:131-163`.

Context variables set by `authMiddleware` (both): `auth: AuthContext`, `session: SessionContext`, `ability: AppAbility` — `mirevue/src/api/middleware/auth.ts:14-20`, `guidemode/.../middleware/auth.ts:17-23`. `env` and `db` are set earlier by `envMiddleware`/`databaseMiddleware`.

Shape of the contexts (Mirevue, the leaner one) — `mirevue/src/shared/auth.ts:78-101`:

```ts
export interface SessionContext {
  tenantId: string
  userId?: string
  permissions: string[]
  user?: User
  tenantUser?: { role: MembershipRole; tenantId: string; userId: string }
  tenant?: { id: string; name?: string | null; slug?: string | null }
}
```

GM adds `subscription?: SubscriptionInfo` and `isSurveyOnly?: boolean` (`guidemode/packages/types/src/auth.ts:42-59`) — both app-specific.

**Base:** Mirevue. `AuthContext` is a legacy duplicate of `SessionContext` kept for API-key compatibility in both repos; the kit could collapse to one `session` variable plus `ability`, but keeping both costs nothing and Mirevue's `withAuthAndDb(c, handler)` seam (`.claude/rules/api.md:25-29`) already hides the difference from routes. Recommend the kit ship that seam and forbid raw `c.get('session')` in routes, exactly as Mirevue's rules do.

### Env / config

- **Mirevue:** zod schema parsed once from `process.env` at boot (`mirevue/src/config.ts:8-128`), `envMiddleware` just does `c.set('env', config)` (`mirevue/src/api/middleware/env.ts:11-14`). Fails fast, fully typed (`AppConfig`).
- **GM:** hand-written interface + a 90-line object literal copying every key from `c.env` with `process.env` fallback (`guidemode/.../middleware/env.ts:107-201`). Untyped `Record<string, string|undefined>`, no validation, and a documented footgun: a binding omitted from the literal is silently `undefined` at runtime (`env.ts:180-186`).

**Kit synthesis:** GM's *mechanism* (read from `c.env` per request — Workers has no process-wide `process.env` at module-eval time for secrets) with Mirevue's *validation* (zod-parse `c.env` once, memoise per isolate, throw a readable error). Keep `getRequiredEnv(env, key)` for optional-typed provider secrets. Every `process.env.NODE_ENV` read at module scope (`mirevue/src/api/auth/google.ts:47`, `guidemode/.../auth/sessions.ts:134`, `routes/auth/helpers.ts:10/15`) must move to the parsed env — on Workers `process.env` is only populated under `nodejs_compat` with the `nodejs_compat_populate_process_env` flag and is not the right source of truth.

**CF-compat:** both middlewares are CF-safe today; GM's already runs there. Node-only: none.

---

## 2. DB-backed cookie sessions

### Schema

`user_sessions` is identical in both: `id varchar(255) PK` (64-hex random), `user_id → users cascade`, `selected_tenant_id → tenants cascade`, `expires_at timestamptz`, `created_at`, indexes on `(user_id, expires_at)` and `(expires_at)` — `mirevue/src/db/schema/users.ts:29-48`, `guidemode/.../schema/users.ts:39-60`. GM adds `is_survey_only boolean` (app-specific; strip).

`users`: Mirevue is the generic one — `id, username, email UNIQUE, name, avatar_url, is_global_admin, is_blocked, last_login_at, created_at, updated_at` (`mirevue/src/db/schema/users.ts:7-27`). GM carries `github_id`, `jira_account_id`, `linear_user_id`, `email_is_placeholder`, `first_session_uploaded_at` (`guidemode/.../schema/users.ts:18-31`) — all sync-integration baggage; strip. Keep Mirevue's `lastLoginAt` (stamped in `createSession`, `sessions.ts:35-38`) — it is the cheap "invited vs actually signed in" signal.

Note Mirevue uses the array form of `pgTable` extraConfig and GM the deprecated object form; kit uses the array form.

### Session lifecycle (lib)

`mirevue/src/api/auth/sessions.ts` — 112 lines, the whole API:

- `generateSessionId()` — 32 bytes via `crypto.getRandomValues`, hex (`:7-12`). Web Crypto, CF-safe.
- `createSession(db, userId, selectedTenantId?, opts?)` — 7-day TTL (`:5`, `:19-41`).
- `validateSession(db, id)` — join user, delete if expired, **sliding renewal when < 1 day left** (`:43-73`).
- `deleteSession`, `extendSession`, `updateSelectedTenant`, `deleteUserSessions` (`:75-97`).
- `createSessionCookie(id)` / `deleteSessionCookie()` — hand-rolled string: `sessionId=…; HttpOnly; SameSite=Lax; Path=/; Expires=…` plus `; Secure` only in production (`:99-112`). No `Domain` attribute, deliberately.

GM's is the same plus `isSurveyOnly` TTL (4h) and an `ANALYTICS_ENGINE.writeDataPoint` login event (`guidemode/.../auth/sessions.ts:7, 47-58`). The Analytics Engine hook is a nice CF touch but optional; the kit can expose an `onLogin?: (evt) => void` seam instead of hard-wiring the binding.

**Base:** Mirevue. Two kit changes: (a) build cookies with `hono/cookie`'s `setCookie`/`deleteCookie` instead of string concatenation (neither repo does — grep confirms zero `setCookie` uses in either `routes/auth`); (b) take `secure` from parsed env, not `process.env` at module scope.

### Session lookup in `authMiddleware`

This is where GM is architecturally better and Mirevue should not be copied verbatim:

- **Mirevue** — 4-5 sequential round trips per request: session+user, membership for selected tenant, fallback first membership, tenant info, then awaited `touchTenantLastAccessed` and awaited session-extend (`mirevue/src/api/middleware/auth.ts:143-296`). Fine on a same-host Postgres; wrong shape for a Worker talking cross-region through Hyperdrive.
- **GM** — one `db.execute(sql\`…\`)` with two `LEFT JOIN LATERAL`s that resolves session + user + best membership (selected tenant if still valid, else oldest) + tenant name/slug (+ subscription) in a single round trip (`guidemode/.../middleware/auth.ts:315-378`), then all side-effect writes (delete-expired, extend, clear-stale-selection, touch tenant) go through `fireAndForget`, which uses `c.executionCtx.waitUntil` with a Node fallback (`auth.ts:189-204`):

```ts
function fireAndForget(c: Context, query: PromiseLike<unknown>, what: string): void {
  const guarded = Promise.resolve(query).catch(err => { logger.warn({ err }, `Failed to ${what}`) })
  try { c.executionCtx.waitUntil(guarded) } catch { /* not on Workers */ }
}
```

**Kit:** port GM's LATERAL query and `fireAndForget`; delete the `tenant_subscriptions` lateral, the `is_oss_corpus` filter, `github_id`, and `is_survey_only`. Keep Mirevue's richer 403 semantics that GM lacks: `tenant_suspended` check (`mirevue auth.ts:104-106, 253-256`) and `code: 'pending_approval' | 'no_tenant'` for users with no membership (`auth.ts:237-250`) — the UI routes on those codes. Also keep Mirevue's `globalAdminMiddleware` (tenant-free context for `/api/admin/*`, `auth.ts:318-388`) if the kit ships a global-admin surface; GM only has the weaker `requireGlobalAdmin` after `authMiddleware`, which 403s an admin who belongs to no tenant.

Role→permissions mapping is identical and crude in both: `owner → ['admin','read','write']`, else `['read','write']` (`mirevue auth.ts:258-260`). CASL (`createAbilityFromSession`) is the real authorisation layer; `permissions[]` exists for API keys. Keep as is.

### `/auth/session` endpoint

Both: `GET /auth/session` is **not** behind `authMiddleware` (so a user with no tenant can still be told they are pending). Tries Bearer key first, then cookie; returns `{ authenticated, user, tenants[], currentTenantId, permissions: ability.rules, tenantUser, apiKey? }` and auto-selects the first tenant if none selected — `mirevue/src/api/routes/auth/session-management.ts:27-172`; GM `session-management.ts:16-183`. Mirevue's response schema is zod-declared and shared with the UI (`mirevue/src/shared/auth.ts:46-66`).

App-specific to strip: Mirevue `rewiredEnabled`, `accessRequest` (keep `accessRequest` only if the kit adopts the access-request onboarding model — see §9); GM `version`, `subscription`, `billingEnabled`, `isSurveyOnly`, `isOssCorpus`, `firstSessionUploadedAt`, avatar-proxy rewriting.

Also in this router: `GET /auth/methods` (Mirevue only — which providers have client id+secret configured, drives login buttons; `session-management.ts:17-24`), `POST /auth/select-tenant` (verifies membership, updates `selected_tenant_id`), `POST /auth/logout` (delete row + expire cookie). Mirevue validates `select-tenant` with zod; GM reads `c.req.json()` raw. **Base:** Mirevue, all four.

---

## 3. OAuth providers (arctic)

### Provider inventory

| Provider | Mirevue | GM | Mechanism |
|---|---|---|---|
| Google | yes | yes | arctic `Google`, PKCE, userinfo endpoint, **rejects `email_verified === false`** (`mirevue/.../oauth-google.ts:134-141`) |
| Microsoft Entra ID | yes | yes | arctic `MicrosoftEntraId('common', …)`, PKCE, Graph `/me` (`mirevue/src/api/auth/microsoft.ts:20-27`) |
| Slack | yes (OIDC sign-in only) | yes (OIDC + app install) | hand-rolled OIDC: state + nonce cookies, `openid.connect.*` endpoints (`mirevue/src/api/auth/slack.ts:1-5, 71-80`) |
| GitHub | — | yes | arctic `GitHub`; callback also handles GitHub App `setup_action` and CLI redirect cookie |
| GitLab | — | yes | arctic `GitLab` |
| Jira, Linear, Notion (login + integration) | — | yes | integration-flavoured; tokens also land in installation tables |
| magic_link | yes | yes | see §4 |
| dev-login | yes | — | see §4 |

### Provider abstraction — there isn't one

Each provider is a pair: a small lib file (`auth/<provider>.ts`: client factory, `fetchXUser`, state/PKCE cookie helpers) and a ~280-line route file (`routes/auth/oauth-<provider>.ts`) that is a **copy-paste of the same callback** with the provider name substituted. The Google route is the canonical one — `mirevue/src/api/routes/auth/oauth-google.ts`:

1. `GET /` — read `link=true` (must have valid session; sets `google_link_mode` cookie), validate `returnUrl` (sets `auth_return_url` cookie), `generateState()` + arctic `generateCodeVerifier()`, set `google_oauth_state` and `google_code_verifier` cookies (10 min, HttpOnly, Lax, Secure-in-prod), redirect to `createAuthorizationURL` (`:30-89`).
2. `GET /callback` — handle provider `error` param, check `state === storedState` and presence of verifier (400 otherwise), `validateAuthorizationCode(code, verifier)`, fetch profile, build `userData` incl. access/refresh tokens + `tokenExpiresAt` + scopes (`:94-156`).
3. Link mode → `linkProviderToUser` → redirect to `/settings?provider_linked=google` or validated return URL (`:159-212`).
4. Login mode → `createOrUpdateUserFromOAuth` → `handleLoginPrologue` (pending invitation takes over) → pick default tenant → `createSession` → set cookie, clear state cookies → redirect to return URL or `/` (`:215-270`).

Redirect URI: Mirevue derives `${env.APP_URL}/auth/google/callback` (`:35`); GM requires a separate `GOOGLE_REDIRECT_URI` / `GITLAB_REDIRECT_URI` / … env var (`guidemode/.../oauth-google.ts:31`, `wrangler.toml [vars]`). **Kit:** derive from `APP_URL`; one fewer var per provider and it cannot drift from the CSRF allowlist.

Cookie helper inconsistencies to normalise in the kit:
- GM `github.ts:36-43` hard-codes `; Secure` on the state cookie — breaks the flow over `http://localhost`.
- Mirevue `google.ts:47-48` computes `isProduction` from `process.env` at module scope; `slack.ts:54` takes `isProduction` as a parameter. The kit should have **one** `authCookie(name, value, {maxAge, secure})` helper driven by the parsed env, and one generic `oauthStateCookies(provider)` that names `${provider}_oauth_state` / `${provider}_code_verifier` / `${provider}_link_mode`.

**Kit design recommendation:** collapse the N route files into one `oauth-router.ts` driven by a `ProviderDefinition`:

```ts
interface OAuthProviderDef {
  id: 'google' | 'microsoft' | 'slack' | 'github' | …
  configured(env): boolean                       // both client id + secret present
  client(env, redirectUri): { createAuthorizationURL; validateAuthorizationCode }
  usesPkce: boolean; usesNonce?: boolean
  scopes: string[]
  fetchProfile(tokens): Promise<{ providerUserId; email; emailVerified?; name; username; avatarUrl? }>
}
```

Google/Microsoft/GitHub/GitLab are thin arctic wrappers; Slack OIDC is the one that needs `usesNonce` and its own token exchange. `/auth/methods` then falls out of `configured()`.

### Account linking / user upsert

`createOrUpdateUserFromOAuth(db, provider, userData, env)` — `mirevue/src/api/auth/oauth-providers.ts:28-141`:

1. `oauth_providers` row for `(provider, providerUserId)` exists → update tokens/avatar, return that user.
2. Else a `users` row with the same email exists → insert provider row linking to it, refresh profile (**email-based account linking**).
3. Else create user + provider row, `isNewUser: true`.

`linkProviderToUser` (`:147-223`) refuses if the provider account is linked to another user; `unlinkProvider` (`:230-255`) refuses to remove the last permanent login method; `getUserProviders`/`canUnlinkProvider` filter out temporary magic-link rows via `(provider != 'magic_link' OR hashed_token IS NULL)`.

GM's version (`guidemode/.../auth/oauth-providers.ts:53-290`) inserts a step between 1 and 2: look up `users.githubId / jiraAccountId / linearUserId` for users pre-created by org/workspace sync with placeholder emails, and call `mergeUsers` (`user-merge.ts`, 359 lines) when the OAuth email belongs to a different real user. Entirely sync-integration machinery. **Strip.**

Email-based linking is a deliberate trust decision — it means any provider that asserts an email can attach itself to an existing account. Mirevue mitigates for Google via the `email_verified` check; Microsoft (`mail ?? userPrincipalName`) and Slack (`email_verified` is available in the OIDC userinfo but grep shows it is not enforced) do not check. The kit should make `emailVerified` part of the profile contract and refuse linking when it is explicitly `false`.

**Base:** Mirevue `oauth-providers.ts` unchanged apart from narrowing the `OAuthProvider` union to whatever the kit ships.

### `oauth_providers` schema

Identical core in both: `id, user_id, provider, provider_user_id, email, hashed_token, access_token, refresh_token, token_expires_at, scopes text[], avatar_url, timestamps` + indexes on user, `(provider, provider_user_id)`, `(provider, email)`, `hashed_token`, `token_expires_at` — `mirevue/src/db/schema/oauth-providers.ts:5-36`. GM adds `atlassian_api_token*`/`atlassian_org_id` (strip). Note `(provider, provider_user_id)` is a plain index, not unique, in both — the comment says "prevent duplicate" but nothing enforces it; the kit should make it a unique index (`hashed_token IS NULL` rows only, or a partial index) — flagged in Open Questions.

---

## 4. Email magic link (and dev login)

`mirevue/src/api/auth/magic-link.ts` (330 lines) is the base. Flow:

- **Token:** HMAC-SHA256 over `JSON{email, timestamp, expiry}` with Web Crypto, encoded `base64(payload).base64(sig)`; 15-minute expiry (`:9, :22-53`). `verifySignedToken` re-verifies and checks expiry (`:59-96`). Invite tokens are the same scheme with `purpose: 'invite'`, 7 days (`:240-318`). GM adds a third purpose, `survey_access` (`guidemode/.../magic-link.ts:322-400`) — app-specific, but it shows the pattern generalises; the kit should ship one `signedToken(purpose, payload, ttl)` / `verifySignedToken(purpose)` pair instead of three copies.
- **Secret:** Mirevue signs with `OAUTH_ENCRYPTION_KEY` (`:14-16`). **GM derives the secret from `DATABASE_URL`** — `` `magic-link-secret-${databaseUrl.slice(0, 32)}` `` (`guidemode/.../magic-link.ts:113-116`, used at `routes/auth/magic-link.ts:31-34`). That is a low-entropy, credential-adjacent secret and a rotation nightmare. **Do not port.** Kit: a dedicated `AUTH_SIGNING_KEY` (or reuse `OAUTH_ENCRYPTION_KEY` as Mirevue does — one fewer secret, but coupling rotation of two concerns).
- **Storage:** `storeMagicLinkToken(email, token)` upserts the user (username/name = local part), deletes earlier *temporary* magic-link rows for that user, inserts a row in `oauth_providers` with `provider='magic_link'`, `hashed_token=hashToken(token)` (`:120-170`). `hashToken` is `btoa(token)` (`:101-103`) — that is encoding, not hashing; the DB row is effectively the plaintext token. Cheap fix for the kit: SHA-256 via `crypto.subtle.digest` (already used for API keys).
- **Consume:** `verifyAndConsumeMagicLink` verifies the signature, then does an atomic `DELETE … RETURNING` on `(provider, email, hashed_token)` so a double-click yields `already_used` for the second request (`:181-238`). Distinguishes `expired | invalid | already_used`.
- **Permanent provider row:** after first successful verify, the route inserts a `magic_link` row with `hashed_token = NULL` so the account has a durable login method (`routes/auth/magic-link.ts:107-117`).
- **Cleanup:** `cleanupExpiredMagicLinks(db)` (`:324-330`) — meant for a cron; neither app appears to call it. Kit: wire into the `scheduled` handler.

Route (`mirevue/src/api/routes/auth/magic-link.ts`): `POST /request` (zod-validated email + returnUrl) → sign, store, build `${APP_URL}/magic-link/verify?token=…&returnUrl=…`, then:

```ts
// No email provider configured: log the link so login still works
if (!env.RESEND_API_KEY) {
  logger.info({ email, magicLinkUrl }, '[MagicLink] Sign-in link (email not sent)')
  if (config.NODE_ENV === 'production') logger.warn('RESEND_API_KEY is not set — magic links are logged, not emailed')
}
```
(`:43-50`), then `sendEmail(...)` which itself no-ops without the key (`services/email.ts:9-20`). `GET /verify` just redirects to the SPA page; `POST /verify` consumes the token, honours `selectTenant` only if the user is a member (`:148-155`), runs the login prologue, sets the cookie, returns `{ success, redirectUrl }` as JSON (the SPA does the navigation).

GM's route has the same shape but **lacks the log-the-link behaviour** (its `email.ts:8-9` only warns) — Mirevue's is the one the task asked for. GM's `sendEmail` uses plain `fetch` to Resend in both repos: CF-safe, no SDK.

**Dev login** (Mirevue only, `routes/auth/dev-login.ts`): `POST /auth/dev-login {email}` creates/gets the user and issues a session; hard-404s when `NODE_ENV === 'production'` (`:23-25`). Worth keeping in the kit behind the same guard — it makes local multi-account testing trivial.

**Important (Mirevue only):** `storeMagicLinkToken` deliberately takes **no `db` argument** and calls `getDatabase()` for the system pool, because `oauth_providers` is `REVOKE`d from the RLS app role (`magic-link.ts:105-124`, `db/schema/CLAUDE.md` "Four tables are REVOKEd"). This only matters if the kit adopts Mirevue's RLS model — see Open Questions. Otherwise restore the `db` parameter (GM's signature).

---

## 5. OAuth token encryption at rest and token refresh

### Encryption

`oauth-encryption.ts` — AES-256-GCM via Web Crypto, `base64(iv‖ciphertext‖tag)`, 12-byte IV — `mirevue/src/api/auth/oauth-encryption.ts:13-84`. Mirevue's `importKey` accepts a base64 32-byte key **or** any string (SHA-256-derived), so `openssl rand -hex 32` works (`:23-33`); GM's only accepts base64 (`guidemode/.../oauth-encryption.ts:17-21`). Both carry `decryptLegacy` XOR + `decryptWithFallback` for pre-migration rows (`:89-114`) — **drop in the kit**, there is no legacy data. `generateEncryptionKey()` (`:128-131`) is handy for a setup script.

`token-crypto.ts` — `encryptToken(token|null, env)` / `decryptToken(…)` null-safe wrappers that **pass plaintext through when `OAUTH_ENCRYPTION_KEY` is unset** (`mirevue/src/api/auth/token-crypto.ts:26-55`). Mirevue's zod config makes the key required (`min(32)`, `config.ts:27`), so the passthrough is dead in practice; GM's is live. Kit: make the key required and delete the passthrough — silent plaintext storage is not a dev convenience worth having.

Call sites: `createOrUpdateUserFromOAuth`/`linkProviderToUser` encrypt before every write (`oauth-providers.ts:34-36, 154-156`). Nothing in either app's *auth* path ever decrypts — the login tokens are stored and never used again. Decryption is only used by GM's integration sync services. **Kit decision:** still store them (they are needed the moment any integration wants to act as the user), but note the cost is an extra 2 Web Crypto ops per login, which is negligible.

**CF-compat:** pure Web Crypto (`crypto.subtle`, `crypto.getRandomValues`, `btoa/atob`). Zero node deps. GM runs this exact code on Workers today.

### Token refresh cron

The task asked about a "token refresh cron". Finding: **GM's daily 3am job (`wrangler.toml [triggers] crons`, `src/scheduled.ts:34, 47`) refreshes only integration installation tables** — `jira_installations` and `linear_installations` via `services/token-refresh/{jira,linear}.ts` (`token-refresh/index.ts:1-14`). It never touches `oauth_providers` user tokens (Google/Microsoft/GitHub refresh tokens are stored but never refreshed). The Linear one is representative: select rows with `refresh_token IS NOT NULL AND token_expires_at < now()+1d`, decrypt, call provider, encrypt, update, and raise an in-app notification on failure (`token-refresh/linear.ts:28-60`).

Mirevue has no cron at all for auth (it uses pg-boss for agents).

**Kit:** ship the `scheduled` handler shape from GM (`index.ts:717-724` exports `{ fetch, queue, scheduled }`; `scheduled.ts` dispatches on derived UTC hour), with two auth jobs wired: expired `user_sessions` purge and `cleanupExpiredMagicLinks`. Provide a `refreshProviderTokens(db, env, providerDef)` hook that iterates `oauth_providers` for providers whose def exposes `refreshAccessToken`, but treat it as optional — no provider in Mirevue's set needs refreshed login tokens.

---

## 6. API keys

Near-identical in both repos.

- **Schema `keys`:** `id, tenant_id, name, key_hash UNIQUE, key_prefix, created_by, user_id, expires_at, last_used_at, is_active, permissions text 'read,write', created_at, revoked_at, revoked_by`; indexes `(key_hash, is_active, revoked_at)`, `(tenant_id, is_active)`, `(key_hash)` — `mirevue/src/db/schema/keys.ts:7-38`.
- **Generation/hash** — `utils/core/keys.ts` (both): `hashApiKey` = SHA-256 hex via `crypto.subtle.digest` (CF-safe); `generateApiKey` uses **`randomBytes` from `node:crypto`** (`guidemode/.../utils/core/keys.ts:1, 16`) — the one node-only import in the whole auth surface. Works under `nodejs_compat` but swap for `crypto.getRandomValues(new Uint8Array(32))`. Prefix differs only by brand: Mirevue `exec_`, GM `gai_` (`diff` line 17) — parameterise (`API_KEY_PREFIX` const, not env).
- **Validation** — `validateApiKey(db, key)` hashes, `findFirst` on `(key_hash, is_active, revoked_at IS NULL)` with the user relation, splits `permissions` on commas (`mirevue/src/api/routes/keys.ts:13-60`); `updateKeyUsage` stamps `last_used_at` (`:63-66`). Neither checks `expires_at` in `validateApiKey` — confirm and fix in the kit.
- **Middleware path** — Bearer branch of `authMiddleware`: validate, `updateKeyUsage`, require the owning user exists and is not blocked, require the user still has a membership in the key's tenant (so removing a member revokes their keys' access), load tenant info, set contexts (`mirevue auth.ts:65-141`). GM is the same plus subscription loading.
- **Management routes** — `GET/POST/DELETE /api/keys` behind `guardPermission(c, 'manage', 'ApiKey')` (Mirevue `routes/keys.ts:68-150`; GM `routes/settings/api-keys.ts`). Soft revoke (`revoked_at`, `is_active=false`), never hard delete.
- **Scopes** are just the `permissions` CSV (`read,write[,admin]`) checked by `requirePermission(name)` (`auth.ts:302-316`); real authorisation is CASL on the owning user's role. No per-resource scopes in either repo.

GM extra: **`cli-auth.ts`** (`guidemode/.../routes/auth/cli-auth.ts`) — a browser-based device-login flow for a CLI/desktop app: `GET /auth/cli?redirect_uri=` sets a `cli_redirect_uri` cookie, sends the user through normal login, `/auth/cli/select-tenant` → `/auth/cli/generate-key` mints (or rotates) a per-user-per-tenant key named `user-<username>` and **302s to the loopback/custom-scheme URI with `?key=…` in the query string** (`:334-340`). `validateCliRedirectUri` allows only `http://localhost|127.0.0.1` and the app's custom schemes (`helpers.ts:21-40`), which is what makes the query-string handoff acceptable. Generic and useful; ship as an optional module with the scheme allowlist configurable. Not rate-limited in GM (`routes/auth/index.ts:21`).

**Base:** Mirevue `routes/keys.ts` + `utils/core/keys.ts`, GM `cli-auth.ts` optional.

---

## 7. CSRF, redirects, cookies, rate limiting

### CSRF

`csrf.ts` is byte-for-byte the same logic in both (`mirevue/src/api/middleware/csrf.ts`, `guidemode/.../middleware/csrf.ts`): skip safe methods; skip Bearer requests; skip when there is no `sessionId` cookie (nothing to forge); otherwise reject if `Sec-Fetch-Site` is present and not `same-origin|same-site|none`, then reject if `Origin` (or `Referer` when no Origin) is not in `{localhost:3000, localhost:3001, origin(APP_URL)}` (`:36-74`). No CSRF token — relies on `SameSite=Lax` + origin allowlist, which is adequate for a same-origin SPA. Kit: take as is, but read `APP_URL` from parsed env only (drop the `process.env` fallback at `:9`) and make the localhost ports configurable/dev-only.

### Redirect handling

`validateReturnUrl` (both, `routes/auth/helpers.ts:17-33`): must start with `/`, not `//`, not contain `http(s)://`, not be `/login`. Return URL travels in an `auth_return_url` cookie (10 min) for OAuth and as a query param for magic link. OAuth provider `redirect_uri` is derived from `APP_URL` (Mirevue) — keep. CLI redirect allowlist in GM `helpers.ts:21-40` (above).

### Cookie attributes summary

| Cookie | Attrs | TTL |
|---|---|---|
| `sessionId` | HttpOnly; SameSite=Lax; Path=/; Secure (prod) ; no Domain | 7d sliding |
| `<provider>_oauth_state`, `<provider>_code_verifier`, `slack_oauth_nonce` | same | 10 min |
| `<provider>_link_mode`, `auth_return_url`, `pending_invitation`, `cli_redirect_uri` | same | 10 min |

Dev vs prod difference is solely `; Secure`. Everything is `SameSite=Lax`, which is what lets the top-level OAuth redirect back to `/auth/<p>/callback` carry the state cookie. Nothing is `__Host-`-prefixed; consider `__Host-session` in the kit since there is no Domain attribute anyway.

### Rate limiting

- Mirevue: Postgres-backed sliding window in `rate_limit_hits`, per IP via `X-Forwarded-For`, 10/min, applied to `/auth/{slack,microsoft,google,magic-link}/*` (`mirevue/src/api/middleware/rate-limit.ts:7-21, 102-110`; `routes/auth/index.ts:16-19`). Shared across replicas.
- GM: **KV-backed** (`RATE_LIMIT_KV` binding), `CF-Connecting-IP` first, same 10/min, **skips entirely when the binding is absent** (local dev) — `guidemode/.../middleware/rate-limit.ts:15-24`; `services/rate-limiter.ts` is a get/filter/put sliding window with `expirationTtl`.

**Kit:** GM's KV version. Note KV's read-modify-write is not atomic and KV is eventually consistent, so the limit is approximate under concurrent bursts — acceptable for login brute-force throttling, not for billing. If exactness matters later, a Durable Object per IP or Cloudflare's rate-limiting binding is the upgrade path. Also apply it to `/auth/dev-login` and `/auth/cli/*`.

---

## 8. Login prologue, invitations, onboarding divergence

Both share `handlePendingInvitation(c, db, userId, email, cookiesToClear)` (`mirevue/.../routes/auth/helpers.ts:75-171`): (1) `pending_invitation` cookie → validate id/status/expiry/email match → create session → redirect `/invite/accept?token=`; (2) if the user has no memberships, look up pending invitations by email and do the same. Mirevue wraps it in `handleLoginPrologue` which first runs `promoteDirectoryMemberships` (`:58-67`) — a workshop-specific `directory → member` role promotion; strip that step but keep the single-prologue seam (its docstring explains why: five login paths, one place to forget).

Where the two apps **diverge on product policy** after login with no invitation and no membership:

- Mirevue: never auto-creates a tenant; `ensureAccessRequest(db, user, env)` records an `access_requests` row (and emails global admins), the session is created with no tenant, the user lands on `/pending`, and `authMiddleware` returns `403 {code:'pending_approval'|'no_tenant'}` (`oauth-google.ts:236-258`, `auth.ts:237-250`).
- GM: if `isNewUser`, `createTenantForUser(db, user, "<name>'s Team", …)` creates a personal tenant and redirects to onboarding (`guidemode/.../oauth-google.ts:229-241, 262-275`).

This is a genuine product decision for the kit (see Open Questions); the code seam is the same `defaultTenantId === undefined` branch in every login path, so make it a single `onNoTenant(strategy)` hook rather than copy-pasted per provider.

---

## 9. Cloudflare-specific notes (from GM)

- **Runtime:** `compatibility_flags = ["nodejs_compat"]` (`wrangler.toml:4`). All auth crypto is Web Crypto already; the only node import is `randomBytes` in `utils/core/keys.ts` and `Buffer` in `github-app.ts` (app-specific).
- **DB per request:** `databaseMiddleware` builds a fresh drizzle client per request from `PREVIEW_DATABASE_URL || HYPERDRIVE.connectionString || DATABASE_URL` (`guidemode/.../middleware/database.ts:22-28`); `createDatabase` picks `@neondatabase/serverless` (HTTP) for `.neon.tech` URLs, else `postgres` (postgres-js) (`db/client.ts:52-65`). Auth code is driver-agnostic except the LATERAL query uses `db.execute(sql)` and the row typing must tolerate `expires_at` arriving as string (`auth.ts:382`).
- **`waitUntil`:** `fireAndForget` (§2) — the idiomatic way to keep side-effect writes off the response path.
- **KV:** only used for rate limiting and the operation-guard mutex; **not** for sessions. Sessions are pure Postgres in both repos. A KV session cache would be a new design, not a port.
- **Cron:** `[triggers] crons` + exported `scheduled` (§5). Dispatch is by UTC hour, not `event.cron` (`scheduled.ts:63`).
- **Analytics Engine:** login events written in `createSession` (`sessions.ts:47-58`); optional.
- **Static assets / SPA:** `[assets] binding = "ASSETS", not_found_handling = "single-page-application"` — relevant because `GET /auth/magic-link/verify` redirects to an SPA route.
- **`process.env` on Workers:** GM's env middleware and cookie helpers fall back to `process.env`; under `nodejs_compat` it exists but is not where secrets live. Kit rule: nothing reads `process.env` outside the env parser.

---

## 10. Proposed kit auth module (file list)

Single package, Mirevue-shaped paths.

```
src/
  config/env.ts                         # zod schema over c.env; parse once per isolate; AppEnv type
  types/bindings.ts                     # CloudflareBindings (HYPERDRIVE, RATE_LIMIT_KV, ASSETS, …)
  db/schema/
    users.ts                            # users + user_sessions (Mirevue minus workshop comments)
    tenant-users.ts                     # owner|admin|member[,support]; composite PK
    oauth-providers.ts                  # + UNIQUE (provider, provider_user_id) WHERE provider_user_id IS NOT NULL
    keys.ts
  shared/auth.ts                        # zod: userSchema, sessionResponseSchema, authMethodsSchema,
                                        #      magicLinkRequestSchema, selectTenantRequestSchema; AuthContext, SessionContext
  api/auth/
    sessions.ts                         # Mirevue; cookie via hono/cookie; secure from env
    cookies.ts                          # authCookie()/clearCookie(), oauthStateCookies(provider)
    signed-tokens.ts                    # generic HMAC signedToken(purpose, payload, ttl) / verify; SHA-256 hashToken
    magic-link.ts                       # store / verifyAndConsume / cleanup (db param restored)
    oauth-encryption.ts                 # AES-GCM, key derivation; no legacy XOR
    token-crypto.ts                     # null-safe wrappers, key REQUIRED
    oauth-providers.ts                  # createOrUpdateUserFromOAuth, link/unlink/getUserProviders
    providers/
      types.ts                          # OAuthProviderDef contract
      google.ts  microsoft.ts  github.ts  slack-oidc.ts   # thin defs (pick v1 set)
      index.ts                          # registry: PROVIDERS, configuredProviders(env)
    api-keys.ts                         # hashApiKey, generateApiKey (getRandomValues), validateApiKey, updateKeyUsage
  api/middleware/
    env.ts  database.ts  csrf.ts  security-headers.ts
    auth.ts                             # LATERAL single-query session path + fireAndForget; Bearer path;
                                        #   globalAdminMiddleware; requirePermission
    permissions.ts                      # guardPermission / can (CASL)
    rate-limit.ts                       # KV sliding window; skip when binding absent
  api/routes/auth/
    index.ts                            # mounts + rate limits
    oauth.ts                            # ONE generic /:provider and /:provider/callback over the registry
    magic-link.ts                       # /request, GET+POST /verify (log-link when no RESEND_API_KEY)
    dev-login.ts                        # 404 in production
    session-management.ts               # /methods, /session, /select-tenant, /logout
    provider-management.ts              # GET /providers, DELETE /providers/:p, POST /providers/:p/use-avatar
    cli-auth.ts                         # OPTIONAL: device/CLI key handoff with redirect allowlist
    helpers.ts                          # validateReturnUrl, handleLoginPrologue → handlePendingInvitation, onNoTenant hook
  api/routes/keys.ts                    # tenant API key CRUD (soft revoke)
  api/services/email.ts                 # Resend via fetch; no-op + log when unconfigured
  scheduled.ts                          # purge expired sessions, cleanupExpiredMagicLinks, optional provider token refresh
  utils/routes/route-helpers.ts         # withAuthAndDb(c, handler) — the only sanctioned way to read auth in a route
tests/api/
  auth-session.test.ts  auth-magic-link.test.ts  auth-oauth.test.ts  keys.test.ts  csrf.test.ts
tests/helpers/auth.ts                   # createTestUser/Tenant/Session/ApiKey (GM tests/helpers/auth.ts is a good template)
```

## 11. Env vars and bindings the kit needs

Names only. Secrets via `wrangler secret put` / `.dev.vars`; plain vars in `wrangler.toml [vars]`.

**Required**

- `APP_URL` — public origin; derives OAuth redirect URIs, magic-link URLs, CSRF allowlist
- `DATABASE_URL` — local/dev; production uses the Hyperdrive binding
- `OAUTH_ENCRYPTION_KEY` — AES-GCM key for stored provider tokens (32 bytes; base64 or any string, SHA-256-derived)
- `AUTH_SIGNING_KEY` — HMAC key for magic-link/invite tokens (*or* reuse `OAUTH_ENCRYPTION_KEY` as Mirevue does — decide; never derive from `DATABASE_URL`)
- `NODE_ENV` — `development|test|production`; gates `Secure` cookies and `/auth/dev-login`

**Optional (feature-gated when absent)**

- `RESEND_API_KEY`, `EMAIL_FROM` — absent → magic links logged, not sent
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`
- `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (if GitHub ships)
- `LOG_LEVEL`, `RELEASE_VERSION`

**Cloudflare bindings** (`wrangler.toml`, typed in `types/bindings.ts`)

- `HYPERDRIVE` — Postgres pooling (`localConnectionString` for dev)
- `RATE_LIMIT_KV` — KV namespace for auth rate limiting (absent → limiter no-ops)
- `ASSETS` — static SPA
- `[triggers] crons` — at least one daily entry for session/magic-link cleanup
- Optional: `ANALYTICS_ENGINE` for login events

**Dropped from GM:** every `*_REDIRECT_URI` (derive from `APP_URL`), `ADMIN_SECRET`, `PADDLE_*`, `GITHUB_APP_*`, `GITLAB_*`, `JIRA_*`, `LINEAR_*`, `NOTION_*`, `SLACK_SIGNING_SECRET`. **Dropped from Mirevue:** `APP_DATABASE_URL`, `TENANT_SCOPE_MODE` (unless RLS is adopted, see below).

## 12. Open questions and risks

1. **RLS vs Workers DB drivers (structural, decide first).** Mirevue's defence-in-depth relies on `withTenantScope` pinning one `pg` connection per request and `set_config('app.tenant_id')` on it (`mirevue/src/db/client.ts:8-22`, `.claude/rules/api.md:36-46`), and on four auth tables being `REVOKE`d from the app role (which is why `storeMagicLinkToken` takes no `db`). GM's per-request `@neondatabase/serverless` HTTP client and Hyperdrive pooling cannot hold per-connection session state across statements. Options: (a) predicates-only, no RLS (GM's status quo); (b) RLS with the tenant id set per *statement* via a transaction wrapper (`BEGIN; SELECT set_config(...,true); …; COMMIT`) over the WebSocket/pg driver through Hyperdrive; (c) defer. Auth is mostly outside tenant scope either way, but the seam (`withAuthAndDb` handing out `db` vs `unscopedDb`) is shaped by this choice.
2. **No-tenant onboarding policy.** Access-request + `/pending` (Mirevue) vs auto-create personal tenant (GM). Determines whether `access_requests` and global-admin approval routes are in the kit, and what `authMiddleware` returns for a member-less user.
3. **Which providers in v1.** Google + Microsoft + magic link are the cheapest generic set (all arctic/OIDC, all verified-email capable). Slack OIDC is hand-rolled and needs a nonce; GitHub is arctic but GM's route is entangled with GitHub App installs.
4. **Email-based account linking trust.** Keep it (it is what makes "sign in with anything" work across providers) but enforce `emailVerified !== false` for every provider, not just Google. Microsoft's `mail ?? userPrincipalName` needs a decision.
5. **`hashToken` is `btoa`.** Switching to SHA-256 is trivial in a greenfield kit; note it in the migration story if any data is ever imported from either app.
6. **Missing unique constraint** on `oauth_providers (provider, provider_user_id)` in both repos; and `validateApiKey` does not check `expires_at` in either — verify before porting.
7. **Signing key coupling.** One key (`OAUTH_ENCRYPTION_KEY`) for both token encryption and HMAC signing (Mirevue) means rotating one rotates the other. Separate keys cost one more secret.
8. **KV rate limiter is approximate** (non-atomic RMW, eventual consistency) and disabled without the binding. Fine for brute-force throttling; document it. Local dev needs `wrangler dev` KV emulation or the tests' behaviour changes.
9. **Global admin surface.** Mirevue's `globalAdminMiddleware` (tenant-free, `isGlobalAdmin` required) and `support` membership role are the clean model; GM's `requireGlobalAdmin` after `authMiddleware` cannot serve an admin with no tenant. Include only if the kit ships `/api/admin`.
10. **Cookie prefix / naming.** Consider `__Host-session` (no Domain attribute is set anyway) and a single `oauth_state` cookie carrying `provider` instead of one cookie name per provider.
11. **CLI/desktop auth module.** Useful but returns the API key in a redirect query string to a loopback/custom-scheme URI. Keep the allowlist strict and make it opt-in.
12. **Testing on Workers.** Mirevue's tests hit the Hono app directly against a real Postgres (`tests/api/auth-*.test.ts`); GM's do the same with `postgres-js`. Neither uses `@cloudflare/vitest-pool-workers`. Decide whether the kit tests run in `workerd` (needed to exercise `waitUntil`, KV, Hyperdrive bindings) or keep the Node-with-stubbed-bindings approach.
