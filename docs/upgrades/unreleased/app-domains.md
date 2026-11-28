---
breaking: false
migrations: ["example_leave_requests, example_leads (the example domains' tables; kit and fresh copies only — never generate them in an existing app)"]
areas: [api, ui, cli, db, plugin, tooling, docs]
touches_surfaces: [example-hr, example-sales]
requires_surfaces: []
manual: true
---

## What changed

An app can now hold its own concepts in app domains (`defineDomain`, listed in `src/app.ts`), checked with plugins by one boundary check; existing copies get empty domain lists and never the two example domains.

- `defineDomain` / `defineDomainUi` in `@/plugins/api`; a domain is `apps/web/src/<id>/` plus its contracts in `packages/shared/src/<id>/` and optional CLI commands in `apps/cli/src/<id>/`.
- Five app-owned lists wire domains: `apps/web/src/app.ts`, `app-ui.ts`, `app-schema.ts`, `packages/shared/src/app.ts`, `apps/cli/src/app.ts`.
- Every registry iterates units (plugins, then domains): `apps/web/src/units/server.ts`, `units/ui.ts`, `packages/shared/src/units.ts`.
- `scripts/lib/units.mjs` is the boundary check, run by `tests/config/units.test.ts`, `pnpm plugin check`, and `pnpm plugin add` before copying.
- Plugin ids `core`, `kit` and `app` are reserved; a plugin may not share a domain's id or define a table in a domain's namespace.
- `kit:upgrade` never ports the app lists (`skipped-app-owned`), creates each empty where missing, and reports a new `kind: "example"` surface as "available, not applied", recording it absent.
- `@testkit/integration` exports `runAgent` (claim and execute one run in-process); `pnpm design:lint` and the guard's UI check read each domain's `ui/`; domain tests in `apps/web/tests/<id>/` join the vitest projects.
- `example-hr` and `example-sales` are new example surfaces, for fresh copies only.

## How to apply

- Run `pnpm kit:upgrade --apply`: it creates the five app lists empty and ports the core that reads them. Never copy the kit's own lists, which name its examples.
- Skip migration `0038_kit-example-domains.sql`: it creates only the example tables. Run `pnpm db:generate` and confirm it produces no migration.
- Leave `example-hr` and `example-sales` out; the upgrade records them absent in `.rocketflare.json`.
- If one of your plugins has the id `core`, `kit` or `app`, rename it before `pnpm plugin check`.
- If an app-owned concept lives in an in-tree plugin, you may keep it there; moving it into a domain is optional.

## Conflicts to expect

- Each core file that read `serverPlugins` / `uiPlugins` / `sharedPlugins` now reads `serverUnits` / `uiUnits` / `sharedUnits`. A local edit beside one of those loops may conflict; keep your line and the new name.

## Verify

- `pnpm test config apps/web/tests/config/units.test.ts` passes.
- `pnpm plugin check` passes.
- `pnpm gate` passes.
