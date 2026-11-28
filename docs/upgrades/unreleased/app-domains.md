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
- The tool egress check (`tools/egress.ts`, `pnpm plugin check`) reads app domains' tools too, and names `apps/web/src/<id>/` for one without an answer.
- `example-hr` and `example-sales` are new example surfaces, for fresh copies only.
- `@/plugins/api/ui-wiring` exports `defineDomainUi` first, so a domain's UI entry loads when a test imports it before anything else (it crashed with "defineDomainUi is not a function" once a second domain was listed); `tests/example-hr/config/ui-entry.test.ts` pins it.
- `tests/config/knowledge-entity-types.test.ts` and the events check in `tests/config/plugins.test.ts` read every unit, not only plugins, so a domain's entity types and events pass them.
- The rule for where code goes is the same in every doc and skill: a domain holds this app's own concepts and logic; a plugin is a reusable capability that works across domains and across apps. `docs/POSITIONING.md` is new and holds the positioning; `CLAUDE.md`, the README, `docs/CONCEPTS.md` and `docs/ADAPTING.md` open with its first line.
- `docs/CONCEPTS.md` §20 ("Adopting an app-owned plugin as a domain") is the recipe for adopting an app-owned plugin as a domain, rehearsed on `example-feature`; `/rf-how-do-i` plans an app's own process as a domain, and its worked orders slice is now a domain.

## How to apply

- Run `pnpm kit:upgrade --apply`: it creates the five app lists empty and ports the core that reads them. Never copy the kit's own lists, which name its examples.
- Skip migration `0038_kit-example-domains.sql`: it creates only the example tables. Run `pnpm db:generate` and confirm it produces no migration.
- Leave `example-hr` and `example-sales` out; the upgrade records them absent in `.rocketflare.json`.
- If one of your plugins has the id `core`, `kit` or `app`, rename it before `pnpm plugin check`.
- An app-owned plugin may stay a plugin: it is already a unit. To move one into a domain, follow the recipe in `docs/CONCEPTS.md` §20 after this upgrade — copy its trees out, `pnpm plugin remove <id> --apply --allow-dirty`, `defineDomain`, one line per app list, and no migration (`pnpm db:generate` must print "No schema changes").
- Take `apps/web/src/plugins/api/ui-wiring.ts` as it is, keeping the `biome-ignore-all` comment, or `pnpm lint:fix` moves the export back.
- Take the docs as they are where you have not rewritten them (`docs/POSITIONING.md`, `docs/ADAPTING.md` §3, `docs/CONCEPTS.md` §16 and §20, the `rf-how-do-i`, `rf-plugin` and `rf-design` skills); where you have, carry over the rule's wording.

## Conflicts to expect

- Each core file that read `serverPlugins` / `uiPlugins` / `sharedPlugins` now reads `serverUnits` / `uiUnits` / `sharedUnits`. A local edit beside one of those loops may conflict; keep your line and the new name.

## Verify

- `pnpm test config apps/web/tests/config/units.test.ts` passes.
- `src/app.ts` and its four twins exist with empty lists, and no `example-hr` or `example-sales` tree was added.
- `pnpm plugin check` passes.
- `pnpm gate` passes.
