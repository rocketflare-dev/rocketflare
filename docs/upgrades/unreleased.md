---
version: unreleased
previous: 0.32.1
date: null
breaking: false
migrations: []
areas: [ui]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

A kit UI test that failed intermittently on slow CI runners now waits for the side nav to take its width after a route change.

- `apps/web/tests/ui/plugin-route-tiers.test.tsx` waits for the side nav's `w-16` / `w-56` class, which lands one render after the page content; it failed in a plugin repository's CI.

## How to apply

1. Copy `apps/web/tests/ui/plugin-route-tiers.test.tsx` from this release over yours, unless you changed it; if you did, wrap each `expect(sideNav()).toHaveClass(...)` that follows a navigation in `await waitFor(() => ...)`.

## Conflicts to expect

None.

## Verify

1. `pnpm web test:ui` passes.
