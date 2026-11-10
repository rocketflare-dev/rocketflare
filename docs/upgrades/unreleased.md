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

A kit UI test that failed on slow CI runners now waits for the page it navigates to, not for text the page it leaves also contains.

- `apps/web/tests/ui/plugin-route-tiers.test.tsx` "returns to the saved state on leaving" waits for `/^shell/`: the editor fixture's "to shell" link matched `'shell'`, so the wait passed while the lazy shell page was still loading; it failed in a plugin repository's CI.

## How to apply

1. In `apps/web/tests/ui/plugin-route-tiers.test.tsx`, change the wait after clicking "to shell" from `toHaveTextContent('shell')` to `toHaveTextContent(/^shell/)`.

## Conflicts to expect

None.

## Verify

1. `pnpm web test:ui` passes.
