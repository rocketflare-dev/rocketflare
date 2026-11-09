---
version: unreleased
previous: 0.28.0
date: null
breaking: true
migrations: []
areas: [api, config, shared, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Google, Microsoft and OIDC sign-in move from the deprecated arctic to `openid-client`, and three dependency advisories are closed by moving AG-UI to 1.0.4 and pinning patched esbuild and postcss-selector-parser.

- `apps/web/src/api/auth/providers/openid.ts` is the one `OAuthClient` the three providers return: code + PKCE (S256) through `openid-client`, given a `Configuration` and whether the provider sends a nonce.
- `OAuthClient.validateAuthorizationCode(callbackParams, { state, verifier, nonce })` replaces `validateAuthorizationCode(code, verifier)`: the router passes the callback's whole query, and `openid-client` checks state, PKCE and nonce itself. `toTokenSet` is gone.
- Microsoft discovers the `common` authority (cached per isolate for `DISCOVERY_TTL_MS`), so an `id_token` naming the person's own tenant is accepted and one naming another tenant is refused. Google uses fixed endpoints. Both authenticate with HTTP Basic, as before.
- `oidc.ts` builds its `Configuration` from the cached discovery document, which now keeps `id_token_signing_alg_values_supported` and `authorization_response_iss_parameter_supported` — so an issuer that advertises the latter must send `iss` on the callback. Its `jose` verification of the `id_token` is unchanged.
- `isAccessDeniedAtTokenExchange` is async and reads `openid-client`'s errors, so a Cognito denial is still `no_access` whatever its body's content type. A token response must be `application/json`; any other failed exchange is `oauth_failed`.
- `routes/auth/oauth.ts` draws state, verifier and nonce from `openid-client` (`randomState`, `randomPKCECodeVerifier`, `randomNonce`).
- `@ag-ui/core`, `@ag-ui/encoder` and `@ag-ui/proto` are pinned at `1.0.4` (were `1.0.3`). `@ag-ui/proto@1.0.4` takes zod as a peer, so the only zod left is the kit's own (GHSA-mrhx-c7xc-m3w5).
- `pnpm-workspace.yaml` gains `overrides`: `@esbuild-kit/core-utils>esbuild` → `0.25.12` (GHSA-67mh-4wv8-2f99, reached through `drizzle-kit`) and `@tailwindcss/typography>postcss-selector-parser` → `6.1.5` (GHSA-rj75-hqrm-r3gf).
- A copy upgraded to 0.28.0 may still resolve `source-map-js@1.2.1`, which the kit's lockfile already moved to `1.2.2`; the steps below refresh it.

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

## Conflicts to expect

- `apps/web/src/api/auth/providers/types.ts` → `OAuthClient.validateAuthorizationCode` takes `(callbackParams, checks)` and `toTokenSet` is removed → keep your own fields on `OAuthProfile` and `ProviderDefinition`; take the kit's `OAuthClient` and `CodeExchangeChecks`.
- `apps/web/src/api/routes/auth/oauth.ts` → the callback passes `new URL(c.req.url).searchParams` and awaits `isAccessDeniedAtTokenExchange` → keep your own changes around both calls.
- `pnpm-workspace.yaml` → `overrides:` added → keep the app's own entries beside the kit's two.

## Verify

1. `rg -n "arctic|@oslojs" apps/web/src apps/web/package.json pnpm-lock.yaml` prints nothing.
2. `pnpm web test:api` passes, including `tests/api/auth-oauth.test.ts` and `tests/api/auth-oidc.test.ts`.
3. `pnpm why zod -r` lists no `zod@3.x`.
4. `pnpm why esbuild -r` lists no `esbuild@0.18.x`.
5. `pnpm why postcss-selector-parser -r` lists no version below `6.1.5`.
6. `pnpm why source-map-js -r` lists no `source-map-js@1.2.1`.
7. `pnpm web db:generate` exits 0, which proves `drizzle-kit` loads the schema under `esbuild@0.25.12`.
8. `pnpm gate` passes.
