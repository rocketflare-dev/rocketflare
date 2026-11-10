---
version: unreleased
previous: 0.32.0
date: null
breaking: false
migrations: []
areas: [shared]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

`EventPayloadOf` now distributes over a union of event names, so an app with two plugins that declare events no longer fails typecheck at every `eventHandlers` list.

- `packages/shared/src/plugins/types.ts`: `EventPayloadOf<S, E>` maps each name in `E` to its payload; a union of names was `never` before.
- `apps/web/tests/config/plugins.test.ts` covers two plugins' declarations and a union of names.

## How to apply

1. In `packages/shared/src/plugins/types.ts`, wrap the body of `EventPayloadOf` in `E extends unknown ? … : never`, as the kit's copy at this release does.

## Conflicts to expect

None.

## Verify

1. `pnpm typecheck` passes with two installed plugins that each declare an event.
2. `pnpm web test:config` passes.
