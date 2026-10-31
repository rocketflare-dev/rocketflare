---
version: unreleased
previous: 0.24.0
date: null
breaking: false
migrations: []
areas: [api]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

OIDC sign-out also sends the return URL as `logout_uri`, so an Amazon Cognito issuer returns to `/login?signedOut=1` instead of showing "Invalid request".

- `oidcEndSessionUrl` (`apps/web/src/api/auth/providers/oidc.ts`) sets `logout_uri` beside `post_logout_redirect_uri`, both `<APP_URL>/login?signedOut=1`; other issuers ignore it.

## How to apply

1. In `apps/web/src/api/auth/providers/oidc.ts`, in `oidcEndSessionUrl`, add `url.searchParams.set('logout_uri', <the same /login?signedOut=1 URL>)` next to `post_logout_redirect_uri`.
2. For a Cognito issuer, register `<APP_URL>/login?signedOut=1` in the app client's sign-out URLs (`logout_urls`).

## Conflicts to expect

`apps/web/src/api/auth/providers/oidc.ts` → `oidcEndSessionUrl` builds the URL from a shared `returnTo` → keep your other changes and take the new lines.

## Verify

1. `pnpm --filter web test:api -- tests/api/auth-oidc.test.ts` passes.
2. `POST /auth/logout` with OIDC configured returns an `endSessionUrl` whose `logout_uri` equals its `post_logout_redirect_uri`.
