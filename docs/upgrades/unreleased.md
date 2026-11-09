---
version: unreleased
previous: 0.28.0
date: null
breaking: true
migrations:
  - "team_invitations.last_sent_at"
  - "invitation_send_counters table (platform, RLS-excluded)"
areas: [api, ui, shared, db, cli, config, docs, scripts, plugins]
touches_surfaces: [feature-chat, feature-agents, feature-knowledge]
requires_surfaces: []
manual: false
---

## What changed

Sign-in moves to `openid-client`, three dependency advisories close, and a hardening round tightens roles, sign-in, API key scopes, AI tools and budgets, the plugin identity seam, CLI output and tooling; trace content capture defaults off.

- `apps/web/src/api/auth/providers/openid.ts` is the one `OAuthClient` the three providers return: code + PKCE (S256) through `openid-client`, given a `Configuration` and whether the provider sends a nonce.
- `OAuthClient.validateAuthorizationCode(callbackParams, { state, verifier, nonce })` replaces `validateAuthorizationCode(code, verifier)`: the router passes the callback's whole query, and `openid-client` checks state, PKCE and nonce itself. `toTokenSet` is gone.
- Microsoft discovers the `common` authority (cached per isolate for `DISCOVERY_TTL_MS`), so an `id_token` naming the person's own tenant is accepted and one naming another tenant is refused. Google uses fixed endpoints. Both authenticate with HTTP Basic, as before.
- `oidc.ts` builds its `Configuration` from the cached discovery document, which now keeps `id_token_signing_alg_values_supported` and `authorization_response_iss_parameter_supported` — so an issuer that advertises the latter must send `iss` on the callback. Its `jose` verification of the `id_token` is unchanged.
- `isAccessDeniedAtTokenExchange` is async and reads `openid-client`'s errors, so a Cognito denial is still `no_access` whatever its body's content type. A token response must be `application/json`; any other failed exchange is `oauth_failed`.
- `routes/auth/oauth.ts` draws state, verifier and nonce from `openid-client` (`randomState`, `randomPKCECodeVerifier`, `randomNonce`).
- `@ag-ui/core`, `@ag-ui/encoder` and `@ag-ui/proto` are pinned at `1.0.4` (were `1.0.3`). `@ag-ui/proto@1.0.4` takes zod as a peer, so the only zod left is the kit's own (GHSA-mrhx-c7xc-m3w5).
- `pnpm-workspace.yaml` gains `overrides`: `@esbuild-kit/core-utils>esbuild` → `0.25.12` (GHSA-67mh-4wv8-2f99, reached through `drizzle-kit`) and `@tailwindcss/typography>postcss-selector-parser` → `6.1.5` (GHSA-rj75-hqrm-r3gf).
- A copy upgraded to 0.28.0 may still resolve `source-map-js@1.2.1`, which the kit's lockfile already moved to `1.2.2`; the steps below refresh it.
- Only an owner-level actor issues or resends an `owner` invitation; `createInvitation`, `bulkInvite` and `resendInvitation` take a required `actor: RoleView`.
- A member removed from a tenant takes their pending invitations with them; a global admin's stay, and leaving support revokes nothing.
- Accepting an invitation over an `idp` membership leaves the row as it is.
- `person.suspended` clears an issuer-granted global admin; a `manual` grant stays.
- Losing global admin by any route deletes the person's `support` rows, unpins their sessions and closes their sockets in those tenants.
- An identity event with an unmatched `sub` reaches an account by email only when the account has no link at that issuer.
- Invitation mail is bounded: a five-minute resend cooldown (429) and daily Postgres counters per person and per tenant.
- `POST /api/tenants` refuses a pending or rejected person (403 `pending_approval`), answers 409 `idp_managed` under managed tenancy, and stops at `MAX_OWNED_TENANTS_PER_USER` (403 `tenant_limit_reached`).
- A slug change on `PATCH /api/tenant` answers 409 `idp_managed` under managed tenancy.
- A 429 carries `Retry-After` from `RateLimitedError`.
- API key scopes are enforced in `authMiddleware`: `read` allows GET/HEAD/OPTIONS, `write` or `*` allow everything, otherwise 403 `insufficient_scope`.
- `AUTH_OIDC_ONLY=true` turns magic links off on the server, and `/auth/methods` reports `magicLink: false`.
- `GET /auth/cli` no longer creates a key: it goes to `/cli/confirm`, `POST /auth/cli/confirm` creates it, and `rocketflare login` checks a per-login `state`.
- One return-path rule, `isSameOriginPath` (`@rocketflare/shared/paths`), is used by `redirectToSchema` and `safeReturnUrl`.
- Sign-in mail is limited to 5 per 15 minutes per recipient (KV); past that the route still answers 202 and sends nothing.
- `POST /auth/magic-link/verify` runs the Origin and fetch-metadata check even with no session cookie.
- `GET /ws` refuses an `Origin` outside the CORS/CSRF allowlist; a client with no `Origin` is unaffected.
- Removing a member, signing out, blocking a person, suspending a tenant and every identity-provider removal close the affected hub sockets (close code 4001).
- The OAuth flow cookie is `__Host-oauth_state`, always `Secure`; a flow in progress at deploy fails once with `oauth_state_mismatch`.
- Microsoft sign-in matches and links on `userPrincipalName`; `mail` is no longer read.
- `APP_ENV=production` no longer logs a sign-in link, and `/api/invite/:token` logs carry `/api/invite/[redacted]`.
- Chat neither offers nor runs a tool that declares an approval gate; such tools belong to agent runs.
- A tool approval runs only the call the person was shown, once per attempt; `ToolApproval` gains a required `approvedCall`.
- `POST /api/agents/runs` on an exclusive slot held by a run the caller cannot see answers a bare 409 `agent_run_active`.
- The run token budget counts prompt-cache reads and writes.
- While a cost cap applies, a chat call the deployment pays for on a model the price table cannot cost is refused (`BudgetLimit` `unpriced_model`); a tenant's own key is not refused.
- An external-id re-ingest replaces chunks and grants in the upsert's transaction.
- `POST /api/ai/config` keeps a stored key only while the provider and normalised base URL both match.
- `describeAiError` no longer repeats an upstream message for an unmapped status.
- Markdown renders images as links; `MarkdownImageLink` is exported from `@/plugins/api/ui`.
- `OBSERVABILITY_CAPTURE_CONTENT` defaults to `false` in `config.ts` and both tomls.
- The identity seam needs `linkByEmail: true` to create an account as well as to claim one, and never creates or links a `BOOTSTRAP_ADMIN_EMAILS` address; `admitUser` takes a required `proof`.
- `requireTenant` answers 403 `tenant_suspended`, and `signIn` answers `no_access` for a suspended tenant.
- `SsoRequirement` and `signIn` take an optional `connectionId` that binds a claim to its connection.
- `ToolCtx.can(action, subject)` and `memberCan(ctx, { tenantId, userId }, action, subject)` are new plugin entries.
- A plugin `apiPrefixes` entry outside `/api` gets the 1 MB JSON body cap.
- The CLI drops terminal control characters from human output (`--json` unchanged); `Column` gains `style`, and `neutralise` is a new CLI plugin entry.
- `plugin add|upgrade|remove` and `kit:upgrade` refuse any path outside the repository, under `.git/` or through a symlink, before writing (`scripts/lib/repo-paths.mjs`).

## How to apply

1. In `apps/web/package.json`, remove `arctic` and add `"openid-client": "6.8.9"`, then run `pnpm install` so `pnpm-lock.yaml` drops `arctic` and every `@oslojs/*` package.
2. Take the kit's `apps/web/src/api/auth/providers/` (`openid.ts` is new; `types.ts`, `google.ts`, `microsoft.ts`, `oidc.ts` change) and `apps/web/src/api/routes/auth/oauth.ts`.
3. For each `ProviderDefinition` your app added beside Google, Microsoft and OIDC, return `openidOAuthClient(configuration, redirectUri, { sendsNonce })` from its `client()`, with `configuration` an async function returning an `openid-client` `Configuration` for that provider — `new Configuration({ issuer, authorization_endpoint, token_endpoint }, clientId, undefined, ClientSecretBasic(secret))` for a provider without discovery, as `google.ts` does — and delete any call to `toTokenSet`.
4. Replace any test that mocks the `arctic` module with a `fetch` stub of the provider's token endpoint, the way `apps/web/tests/api/auth-oauth.test.ts` stubs Google's and Microsoft's.
5. Change any test stub of `OAuthClient` so its `validateAuthorizationCode` takes `(callbackParams, { state, verifier, nonce })` in place of `(code, verifier)`.
6. Take the kit's wording for `docs/CONCEPTS.md` §2 (the OAuth registry), `docs/CONNECTORS.md` §1, `README.md` ("OAuth registry") and `CLAUDE.md` ("Auth") for any of those you have not edited.
7. In `apps/web/package.json`, set `@ag-ui/core`, `@ag-ui/encoder` and `@ag-ui/proto` to exactly `1.0.4`.
8. In `packages/shared/package.json`, set `@ag-ui/core` to exactly `1.0.4`.
9. In `pnpm-workspace.yaml`, add an `overrides:` map with `'@esbuild-kit/core-utils>esbuild': 0.25.12` and `'@tailwindcss/typography>postcss-selector-parser': 6.1.5`, merged into any `overrides:` the app already has.
10. Run `pnpm install` so `pnpm-lock.yaml` resolves the `@ag-ui/*` 1.0.4 pins and the two `pnpm-workspace.yaml` overrides; `pnpm kit:upgrade` ports no lockfile.
11. Run `pnpm update -r source-map-js` so every transitive `source-map-js` resolves `1.2.2`.
12. Once every Verify step passes, close any open Dependabot security PR for zod, esbuild or source-map-js without merging it: in a pnpm workspace those PRs leave the flagged package unchanged.
13. Port the schema change: add `team_invitations.last_sent_at` (NOT NULL, default now) and the `invitation_send_counters` table, list the table in `RLS_EXCLUDED_TABLES`, then run `pnpm db:generate`.
14. Delete `support` rows left by an earlier demotion: `DELETE FROM tenant_users tu USING users u WHERE tu.user_id = u.id AND tu.role = 'support' AND NOT u.is_global_admin`.
15. Decide the trace content setting: set `OBSERVABILITY_CAPTURE_CONTENT = "false"` in both wrangler tomls, or keep `"true"` deliberately where tenant prompts may leave the database.
16. If a cost cap is set, give every model the platform key or Workers AI binding can serve to an agent a price in `packages/shared/src/ai/pricing.ts`, or unset the cap; agent runs on a tenant's own key are unaffected.
17. Review API keys created with only the `read` scope that send writes, and replace each with a `write` key.
18. Move any headless caller of `GET /auth/cli` to `POST /auth/cli/confirm` with `{"redirectUri": "http://127.0.0.1:<port>/callback"}` and a session cookie, reading `redirectTo` from the answer.
19. Move people who relied on magic links under `AUTH_OIDC_ONLY=true` to the identity provider.
20. Under Microsoft sign-in, link the provider from the existing account first for anyone whose user principal name differs from their account email.
21. Configure `RESEND_API_KEY` on a production deployment that relied on a sign-in link in its logs.
22. Set `MAX_OWNED_TENANTS_PER_USER`, `INVITATION_EMAILS_PER_USER_PER_DAY` or `INVITATION_EMAILS_PER_TENANT_PER_DAY` in both tomls only if the defaults (10, 500, 1000) are too low.
23. In a plugin calling `identityFor().signIn` or `provisionFor().upsertUser`, pass `linkByEmail: true` only for a domain the connection proved, and handle `account_exists`.
24. In a plugin with one connection per tenant, set `connectionId` on the `ssoPolicy` answer and pass the same id to `signIn`.
25. In a public plugin callback that completes a flow an admin started, call `memberCan` after `verifyState` and change nothing on `false`.
26. In a plugin tool that writes, replace a `scope.bypass` check with `ctx.can('manage', YOUR_SUBJECT)`.
27. In a plugin rendering model or document Markdown with its own `react-markdown`, pass `components={{ img: MarkdownImageLink }}` from `@/plugins/api/ui`.
28. In a plugin CLI command printing free text, run server values through `neutralise`, and move chalk from a column's `value` to its `style`.
29. Replace any symlinked directory under `apps/web/src/plugins/`, `docs/plugins/` or `.claude/skills/` with the real directory before the next `plugin add`.
30. Run `node scripts/plugin-api-doc.mjs`.

## Conflicts to expect

- `apps/web/src/api/auth/providers/types.ts` → `OAuthClient.validateAuthorizationCode` takes `(callbackParams, checks)` and `toTokenSet` is removed → keep your own fields on `OAuthProfile` and `ProviderDefinition`; take the kit's `OAuthClient` and `CodeExchangeChecks`.
- `apps/web/src/api/routes/auth/oauth.ts` → the callback passes `new URL(c.req.url).searchParams` and awaits `isAccessDeniedAtTokenExchange` → keep your own changes around both calls.
- `pnpm-workspace.yaml` → `overrides:` added → keep the app's own entries beside the kit's two.
- `apps/web/wrangler.toml`, `apps/web/wrangler.staging.toml` → `OBSERVABILITY_CAPTURE_CONTENT` flipped → keep the value chosen for the trace content setting.
- `apps/web/src/api/routes/auth/cli.ts` → GET no longer creates a key → re-apply local changes to the POST handler.
- `apps/web/src/ui/App.tsx` → new `/cli/confirm` route → keep both.
- `apps/web/src/plugins/api/identity.ts` → seam rules changed → keep plugin-side domain checks and take the new refusals.
- `apps/web/src/api/services/auth.ts` → `AdmitInput.proof` is required → pass `proof` at any local `admitUser` call.
- `apps/web/tests/api/invitations.test.ts` → `createInvitation` takes `actor`; a resend right after a create must backdate `last_sent_at` → update local tests.
- A test asserting `content` on spans → the default is off → set `OBSERVABILITY_CAPTURE_CONTENT: 'true'` in that test's env.

## Verify

1. `rg -n "arctic|@oslojs" apps/web/src apps/web/package.json pnpm-lock.yaml` prints nothing.
2. `pnpm web test:api` passes, including `tests/api/auth-oauth.test.ts` and `tests/api/auth-oidc.test.ts`.
3. `pnpm why zod -r` lists no `zod@3.x`.
4. `pnpm why esbuild -r` lists no `esbuild@0.18.x`.
5. `pnpm why postcss-selector-parser -r` lists no version below `6.1.5`.
6. `pnpm why source-map-js -r` lists no `source-map-js@1.2.1`.
7. `pnpm web db:generate` exits 0, which proves `drizzle-kit` loads the schema under `esbuild@0.25.12`.
8. `pnpm plugin check` passes.
9. A `read`-scoped key on `PATCH /api/me` answers 403 `insufficient_scope`.
10. With `AUTH_OIDC_ONLY=true`, `GET /auth/methods` answers `magicLink: false`.
11. `GET /auth/cli` with a session cookie answers 302 to `/cli/confirm` and creates no API key.
12. `pnpm gate` passes.
