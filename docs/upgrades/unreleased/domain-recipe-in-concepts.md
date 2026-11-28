---
breaking: false
migrations: []
areas: [docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

The recipe for adopting an app-owned plugin as a domain moved from `docs/ADAPTING.md` §3c into `docs/CONCEPTS.md` §20, because `kit:upgrade` never ports `docs/ADAPTING.md` and the docs it does port pointed copies at a section they did not have.

- `docs/CONCEPTS.md` §20 gains "Adopting an app-owned plugin as a domain"; `docs/ADAPTING.md` §3c is now a pointer to it.
- The recipe adds two steps found by running it on a plugin that imports another plugin. In the shared tree, a sibling plugin's contracts move one level down (`../<other>/index` → `../plugins/<other>/index`). A UI slot read in a test is optional too (`ui.queryKeys ?? {}`). It also says that a domain may keep importing a plugin's published entry.
- `CLAUDE.md`, `apps/web/src/plugins/CLAUDE.md`, `example-feature/CLAUDE.md`, `docs/POSITIONING.md`, `apps/web/src/app.ts` and the `rf-how-do-i` and `rf-plugin` skills point at §20.

## How to apply

- Take `docs/CONCEPTS.md` §20, `docs/POSITIONING.md`, the two skills and the CLAUDE.md lines as they are. `docs/ADAPTING.md` is never ported, so leave yours as it is.
- In your `apps/web/src/app.ts`, if its comment names `docs/ADAPTING.md` §3c, change it to `docs/CONCEPTS.md` §20.

## Conflicts to expect

None.

## Verify

- `grep -rn "ADAPTING.md\` §3c" CLAUDE.md docs .claude apps/web/src` prints nothing outside `docs/ADAPTING.md`.
- `pnpm gate` passes.
