---
version: unreleased
previous: 0.24.0
date: null
breaking: false
migrations: []
areas: [cli]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

The CLI login callback server now closes the connection on every response, so its test no longer fails on Node 26.

- `apps/cli/src/auth.ts`: the callback server's 404 now sends `Connection: close` like its other responses. A kept-alive socket stayed in `fetch`'s pool after `close()`, so the next server on the same port got `ECONNRESET` (deterministic on Node 26's undici 8, a race on Node 24).

## How to apply

1. In `apps/cli/src/auth.ts` `handleCallback`, add `Connection: 'close'` to the headers of the 404 `res.writeHead(...)` call.
2. In `apps/cli/tests/login.test.ts`, in the test "rejects on ?error= and on missing key/tenant_id, 404s other paths", assert that the `/other` response's `connection` header is `close`.

## Conflicts to expect

None.

## Verify

1. `pnpm --filter @rocketflare/cli test` passes.
