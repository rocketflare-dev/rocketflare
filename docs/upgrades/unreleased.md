---
version: unreleased
previous: 0.32.2
date: null
breaking: false
migrations: []
areas: [ci]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Plugin CI now proves a plugin the way an adopter runs it, without the kit-only tests, so a plugin that serves public sites no longer fails the kit's shipped-toml check.

- `.github/workflows/plugin-ci.yml`: the gate step runs `git rm -r -q --ignore-unmatch apps/web/tests/kit-only` first, as the rename does for every copy.
- `apps/web/tests/kit-only/plugin-ci.test.ts` pins that step.

## How to apply

1. Nothing to port in an app: `plugin-ci.yml` is called from plugin repositories at `@main`, and a copy has no `apps/web/tests/kit-only/`.

## Conflicts to expect

None.

## Verify

1. A plugin repository's CI run shows no `kit-only` project in the kit's gate.
