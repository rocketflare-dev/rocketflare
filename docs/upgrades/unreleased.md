---
version: unreleased
previous: 0.28.0
date: null
breaking: true
migrations: []
areas: [api, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Google, Microsoft and OIDC sign-in run on `openid-client` instead of arctic, which its maintainer deprecated on 2026-07-29, and the `@oslojs/*` packages arctic pulled in are gone.

- `apps/web/src/api/auth/providers/openid.ts` is the one `OAuthClient` the three providers return: code + PKCE (S256) through `openid-client`, given a `Configuration` and whether the provider sends a nonce.
- `OAuthClient.validateAuthorizationCode(callbackParams, { state, verifier, nonce })` replaces `validateAuthorizationCode(code, verifier)`: the router passes the callback's whole query, and `openid-client` checks state, PKCE and nonce itself. `toTokenSet` is gone.
- Microsoft discovers the `common` authority (cached per isolate for `DISCOVERY_TTL_MS`), so an `id_token` naming the person's own tenant is accepted and one naming another tenant is refused. Google uses fixed endpoints. Both authenticate with HTTP Basic, as before.
- `oidc.ts` builds its `Configuration` from the cached discovery document, which now keeps `id_token_signing_alg_values_supported` and `authorization_response_iss_parameter_supported` — so an issuer that advertises the latter must send `iss` on the callback. Its `jose` verification of the `id_token` is unchanged.
- `isAccessDeniedAtTokenExchange` is async and reads `openid-client`'s errors, so a Cognito denial is still `no_access` whatever its body's content type. A token response must be `application/json`; any other failed exchange is `oauth_failed`.
- `routes/auth/oauth.ts` draws state, verifier and nonce from `openid-client` (`randomState`, `randomPKCECodeVerifier`, `randomNonce`).

## How to apply

1. In `apps/web/package.json`, remove `arctic` and add `"openid-client": "6.8.9"`, then run `pnpm install` so `pnpm-lock.yaml` drops `arctic` and every `@oslojs/*` package.
2. Take the kit's `apps/web/src/api/auth/providers/` (`openid.ts` is new; `types.ts`, `google.ts`, `microsoft.ts`, `oidc.ts` change) and `apps/web/src/api/routes/auth/oauth.ts`.
3. For each `ProviderDefinition` your app added beside Google, Microsoft and OIDC, return `openidOAuthClient(configuration, redirectUri, { sendsNonce })` from its `client()`, with `configuration` an async function returning an `openid-client` `Configuration` for that provider — `new Configuration({ issuer, authorization_endpoint, token_endpoint }, clientId, undefined, ClientSecretBasic(secret))` for a provider without discovery, as `google.ts` does — and delete any call to `toTokenSet`.
4. Replace any test that mocks the `arctic` module with a `fetch` stub of the provider's token endpoint, the way `apps/web/tests/api/auth-oauth.test.ts` stubs Google's and Microsoft's.
5. Change any test stub of `OAuthClient` so its `validateAuthorizationCode` takes `(callbackParams, { state, verifier, nonce })` in place of `(code, verifier)`.
6. Take the kit's wording for `docs/CONCEPTS.md` §2 (the OAuth registry), `docs/CONNECTORS.md` §1, `README.md` ("OAuth registry") and `CLAUDE.md` ("Auth") for any of those you have not edited.

## Conflicts to expect

- `apps/web/src/api/auth/providers/types.ts` → `OAuthClient.validateAuthorizationCode` takes `(callbackParams, checks)` and `toTokenSet` is removed → keep your own fields on `OAuthProfile` and `ProviderDefinition`; take the kit's `OAuthClient` and `CodeExchangeChecks`.
- `apps/web/src/api/routes/auth/oauth.ts` → the callback passes `new URL(c.req.url).searchParams` and awaits `isAccessDeniedAtTokenExchange` → keep your own changes around both calls.

## Verify

1. `rg -n "arctic|@oslojs" apps/web/src apps/web/package.json pnpm-lock.yaml` prints nothing.
2. `pnpm web test:api` passes, including `tests/api/auth-oauth.test.ts` and `tests/api/auth-oidc.test.ts`.
3. `pnpm gate` passes.
