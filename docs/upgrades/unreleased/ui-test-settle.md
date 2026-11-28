---
breaking: false
migrations: []
areas: [ui]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

The UI test setup now settles every React Query client a test rendered with before the file's environment is torn down, so a test ending right after its render can no longer fail the run with "window is not defined".

- `apps/web/tests/ui/helpers/renderWithProviders.tsx` tracks the clients it renders with and exports `settleTestQueryClients()`, which cancels and clears them and flushes one macrotask; `apps/web/tests/ui/setup.ts` calls it in `afterEach`.

## How to apply

- Take both files as they are, if you have not changed them; otherwise add the tracking set, `settleTestQueryClients()` and its call after `cleanup()` by hand.

## Conflicts to expect

None.

## Verify

- `pnpm test ui` passes.
