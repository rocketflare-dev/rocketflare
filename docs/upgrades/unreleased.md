---
version: unreleased
previous: 0.15.5
date: null
breaking: false
migrations: []
areas: [api, ui, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Opening a magic link no longer spends its token: `GET /auth/magic-link/verify` redirects to a new `/magic-link/confirm` page whose "Sign in" button posts the token, so mail scanners (Safe Links, Mimecast) cannot break sign-in.

- `apps/web/src/api/routes/auth/magic-link.ts`: `GET /verify` consumes nothing and 302s to `/magic-link/confirm?token=…[&redirectTo=…]`; the new `POST /verify` (form-encoded) consumes the token, signs in and 303s.
- `apps/web/src/ui/pages/MagicLinkConfirm.tsx`: new public page, a native `<form method="post">` that never auto-submits; routed in `App.tsx`.
- `apps/web/tests/api/auth-magic-link.test.ts`, `invitations.test.ts`: sign in through the confirm step; three GETs leave the token unconsumed.
- `apps/web/tests/ui/magic-link-confirm.test.tsx`: the form posts the right fields and the page sends no request itself.
- The emailed URL is unchanged, so links already sent keep working. See `docs/CONCEPTS.md` §Auth.

## How to apply

1. In `apps/web/src/api/routes/auth/magic-link.ts`, replace the `GET /verify` handler with the kit's two handlers: a `GET /verify` that redirects to `/magic-link/confirm` carrying `token` and `redirectTo`, and a `POST /verify` that reads `token`/`redirectTo` from `c.req.parseBody()` and answers `303`.
2. Copy `apps/web/src/ui/pages/MagicLinkConfirm.tsx` from the kit, and add its lazy import and public `<Route path="/magic-link/confirm">` to `apps/web/src/ui/App.tsx` beside `/magic-link/sent`.
3. In any test of the copy that requests a `verifyUrl` directly and expects a signed-in response, follow the `302` to `/magic-link/confirm` and POST its query string form-encoded to `/auth/magic-link/verify`, as the kit's `signIn` helper in `apps/web/tests/api/auth-magic-link.test.ts` does.
4. Copy `apps/web/tests/ui/magic-link-confirm.test.tsx` and the kit's `apps/web/tests/api/auth-magic-link.test.ts` changes.
5. If a deploy smoke check in the copy curls the verify URL, expect a `302` to `/magic-link/confirm` instead of a signed-in redirect.

## Conflicts to expect

- `apps/web/src/api/routes/auth/magic-link.ts` → the verify handler split into GET and POST → keep local changes to admission or logging inside the POST handler.
- `apps/web/src/ui/App.tsx` → one lazy import and one public route added → keep local routes and add both.

## Verify

1. `pnpm --filter @<slug>/web exec vitest run --project api tests/api/auth-magic-link.test.ts tests/api/invitations.test.ts` passes, including "opening the link (a mail scanner, a preview, a reload) consumes nothing".
2. `curl -si "http://localhost:3001/auth/magic-link/verify?token=x"` answers `302` with `location: /magic-link/confirm?token=x`.
3. Requesting a magic link locally, opening the logged URL and pressing "Sign in" lands on Home.
