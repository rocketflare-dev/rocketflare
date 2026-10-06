---
version: unreleased
previous: 0.17.5
date: null
breaking: false
migrations: []
areas: [config]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Two 0.17.4/0.17.5 tests now pass inside a coding sandbox's ship gate: the bootstrap test runs as root, and the Neon relay test helper negotiates TLS, so it reaches a remote Neon gate branch as well as the local Postgres.

- `apps/web/tests/config/bootstrap-lib.test.ts`: every `bootstrap.mjs` child gets `ROCKETFLARE_ALLOW_ROOT: '1'`; a new test simulates uid 0 (an `--import` preload stubbing `os.userInfo`) and asserts the refusal and the opt-in.
- `apps/web/tests/helpers/ws-pg-relay.ts`: the relay sends an SSLRequest upstream and wraps the socket in TLS on `S` (certificate verified unless the host is local), stays plaintext on `N` only for a local host, sends SNI = the `DATABASE_URL` hostname (Neon routes by it), and buffers the driver's first bytes until the upstream is ready; `relay()` takes an optional target URL.
- `apps/web/tests/config/ws-pg-relay.test.ts` (new): a fake TLS upstream proves the SSLRequest and the SNI.

## How to apply

1. Take `apps/web/tests/config/bootstrap-lib.test.ts` from the kit diff (the `runBootstrap` helper, `AS_ROOT`, `ALL_SKIPPED` and the new "as root" test).
2. Take `apps/web/tests/helpers/ws-pg-relay.ts` from the kit diff.
3. Add `apps/web/tests/config/ws-pg-relay.test.ts` from the kit diff.

## Conflicts to expect

- `apps/web/tests/helpers/ws-pg-relay.ts` → an app that already negotiates TLS in the relay → keep one `openUpstream`, the kit's or yours.
- `apps/web/tests/config/bootstrap-lib.test.ts` → an app that already passes the allow-root variable in `runBootstrap` → keep the kit's helper.

## Verify

1. `pnpm --filter @<slug>/web exec dotenv -e .env.test -- vitest run --project config tests/config/bootstrap-lib.test.ts` passes, as your user and as root.
2. `pnpm --filter @<slug>/web exec dotenv -e .env.test -- vitest run --project api-isolated tests/api/neon-pool-errors.test.ts` passes against the local test Postgres.
3. `pnpm --filter @<slug>/web exec dotenv -e .env.test -- vitest run --project config tests/config/ws-pg-relay.test.ts` passes.
