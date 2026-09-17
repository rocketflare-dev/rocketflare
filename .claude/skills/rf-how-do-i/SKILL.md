---
name: rf-how-do-i
description: Coach someone through adding a feature to this kit — where each layer goes, the decisions the kit forces, and the traps it will fail them on. Use when the user asks how to add or build a feature, resource or screen ("how do I add orders", "I want approvals and a dashboard"), or wants a plan before writing code. Produces a plan, never an implementation.
argument-hint: "[what you want to build]"
---

# How do I build this on the kit?

You are **coaching**, not building. The person leaves with a plan they understand and could hand to
anyone — you leave the code to them (or to a later session). **Write no feature code in this skill**:
no schema file, no route, no component. The one file you may write is the plan in step 5.

Every feature here is one **slice**: a vertical cut through contract → schema → route → UI, with the
same tenant predicate at every depth. A newcomer's instinct is to build one layer at a time across
the whole app; the kit punishes that (a route with no contract, a table with no policy). Teach the
slice.

`$ARGUMENTS` is what they want to build. If it is empty or a single word, ask what it is for and who
uses it before anything else.

## 0. First question: app, or plugin?

Ask it before the interview, because it changes where every file lands (D31, `docs/CONCEPTS.md`
§16). A **plugin** is a separate git repository copied into this app — never npm — that contributes
contracts, schema, routes, jobs, agents, UI and CLI commands through five barrels it is the only
thing allowed to write a line into. Written as a plugin, a feature is one tree you can lift out,
version and install somewhere else; written into core, it is diffused across twenty files nobody
can separate again.

**Default to the plugin.** Core is still right when the change is to the kit's OWN tables
(`tenants`, `users`, `tenant_users`, `documents`…), to auth or tenancy, or to a cross-cutting
middleware — the things a plugin composes ON TOP of and must not redefine. Everything else — a
resource with its own table, its own screens, its own jobs — is a plugin.

Two things to say out loud when the answer is "plugin", because they surprise people:

- **The slice is identical.** Same layers, same order, same traps; only the destination moves. You
  do not teach a different design.
- **It is one repository with its own version and release notes**, installed and upgraded with
  `pnpm plugin` (`/rf-plugin`), and the host generates its migration — the plugin ships none, ever.
  `apps/web/src/plugins/example-feature/` is the worked example of every slot.

Everything the plugin keys carries its id: tables `<id>_*`, job types `<id>.verb`, the API prefix
`/api/<id>`, query-key roots `<id>:…`, the CLI command `<id>`, feature/prompt/agent keys, and AG-UI
CUSTOM events `<id>.` — **never `kit.`**, which is the kit's own namespace.

**Done when** they have said app or plugin, and you have said which of the two reasons decided it.

## 1. Turn the idea into a slice

Interview until you can state the slice in three sentences: **the thing, its states, and who moves
it between them.** Do not skip to layers with a vague noun — "orders" is not yet a design.

Ask only what you cannot infer, and ask it in the kit's terms:

| Question | Why the kit needs it |
|---|---|
| What is the row, and is it owned by an organisation or by a person? | Everything domain-level carries `tenantId`; "mine, not my colleague's" is an *extra* `userId` filter on top, never instead |
| What states does it move through, and what moves it? | A status column plus the transitions is the difference between a CRUD table and a feature. Approval, review, cancellation are all this |
| Who may do each transition? | Becomes a CASL subject and the role row you will add to the matrix. "Admins approve, members request" is a permission design, not an `if` in a handler |
| What must happen but not on the request? | Email, indexing, anything over a second: the route enqueues, never runs (`.claude/rules/api.md`) |
| What will someone want to count? | Decides whether the slice ends at a page or continues into a cube, a fact table and a dashboard |
| Is any of this somebody else's too? | The step-0 question again, now with a real noun: a thing two products would both want is a plugin |
| Does it need to feel live? | A nudge is one line in the service; polling is a fallback, not the default |

**Done when** you can name the entity, list its states, and say who performs each transition — and
they have agreed with that summary. Read it back before moving on.

## 2. Walk the layers in order

`docs/ADAPTING.md` §3 is the authority on *where each file goes* — read it and teach from it rather
than restating it here, so there is one source of truth. **Its table has two columns, "Core location"
and "The plugin slot", one row per layer — read the row for the answer from step 0 and quote that
column.** The slots, in the table's own words, are `SharedPlugin.jobs` / `subjects` / `features` /
`config` / `realtimeRoots` / `agentKeys`, `ServerPlugin.mounts` / `jobHandlers` / `agents` /
`agentTools` / `scheduledTasks` / `grants` / `rlsExcludedTables` / `unscopedAllowlist` /
`visibilityResources` / `hooks`, `UiPlugin.routes` / `nav` / `settingsTabs` / `queryKeys` /
`agentForms`, and `CliPlugin.register` — each reached through one of the four published entry files
(`apps/web/src/plugins/<id>/index.ts`, `.../ui/index.ts`,
`packages/shared/src/plugins/<id>/index.ts`, `apps/cli/src/plugins/<id>/index.ts`) and nothing else.

Your job is the **order and the reason**:

Contract first, because the route validates with it and the UI and CLI parse the same schema — a
type invented in a route is the one thing that reliably rots. Schema second, because the route needs
the table. Route third: thin, `withAuthAndDb` → `guardPermission` → tenant-filtered query. Then the
hook, then the page. Each layer runs green before the next: `pnpm typecheck`, then the layer's test.

For each layer, name **the file in this repo to copy**. Do not invent a shape when one exists —
find the closest existing feature and say so. `git ls-files apps/web/src/api/routes` and the sibling
`CLAUDE.md` in each directory are how you find it.

**Done when** every layer of their slice has a destination path and an existing file to model it on.

## 3. Name the traps before they hit them

These are the kit's invariants — it fails the build or leaks data when they are missed. Cover the
ones their slice touches, and say what enforces each, so the rule is a test and not your opinion:

- **Every domain query filters by `tenantId`** from the auth context, and every tenant table calls
  `tenantIsolation()` in its `extraConfig` — `tests/api/rls-coverage.test.ts` fails the build without
  it. Cross-tenant reads live only in `routes/admin.ts` and the pre-tenant auth path.
- **A new CASL subject** goes in `apps/web/src/permissions/abilities.ts` AND the matrix in
  `docs/CONCEPTS.md` §1. Owner-only actions are an explicit `role === 'owner'` check (`guardOwner`),
  never `manage`, because CASL conditions are not used anywhere in this kit.
- **Routes enqueue, never run.** Long work is `JOBS_QUEUE` or a Workflow; side effects go through
  `defer`. A new job type is a variant in `packages/shared/src/jobs.ts` plus a handler — and the
  `type` string is the version seam, so a breaking payload is a new type, never an edited schema.
- **The realtime `entity` string IS the query-key family root.** `entity.changed { entity: 'order' }`
  invalidates `queryKeys.orders` only if that family is named `['order']`. Pick the string once and
  use it in the service nudge and in `lib/query-keys.ts`.
- **Cube member names are frozen** — dashboards store `Cube.measure` strings in jsonb, so a rename
  silently breaks every saved page. And a new cube is not done until it has a case in
  `tests/api/cubes/cube-isolation.test.ts`; that test is the only thing enforcing tenant scoping in
  the cube layer.
- **The gate** — `pnpm lint && pnpm typecheck && pnpm test && pnpm build` — passes before every
  commit, and a behaviour change updates `docs/CONCEPTS.md` in the same PR.

Four more when the answer to step 0 was "plugin", and every one of them is a test rather than
advice:

- **`tests/config/plugins.test.ts`** is the structural gate: the id is a namespace and never the
  kit's, query-key roots carry the id, nothing reaches into a plugin except through its four
  published entry files, and the plugin's `ui.ts` imports only from a small allowlist with every
  page reached as `lazy(() => import(...))` — that file ships in the MAIN bundle, for every reader,
  including the ones who never open the plugin.
- **`tests/config/shared-imports.test.ts`** pins the leaf rule: nothing under
  `packages/shared/src/plugins/` may import one of the five composers (`ai/agents.ts`, `jobs.ts`,
  `permissions.ts`, `features.ts`, `realtime.ts`) at runtime. They read the plugin barrel, so
  importing one back closes a cycle — and two zod modules in a cycle do not fail to compile, they
  crash at module evaluation with one side `undefined`. A whole-declaration `import type { X } from`
  is fine; `import { type X } from` is not.
- **The tenant-isolation case is required, not optional.** A plugin's own tests live inside its
  directory and run in the host's projects, and the one every plugin with a table must carry is
  "tenant B can neither list, read nor delete tenant A's rows" — plus `tenantIsolation()` in the
  table's `extraConfig`, which `rls-coverage.test.ts` enforces for a plugin table exactly as for a
  kit one.
- **A plugin declares `relations()` for its OWN tables only.** A second `relations()` for a core
  table merges at runtime but not at the type level, and silently strips `with:` from that table's
  query results app-wide. The `one()` side on the plugin's own table expresses the FK fully.

**Done when** you have named every trap their slice actually touches, and skipped the ones it does
not. A slice with no analytics does not need the cube warning.

## 4. Size it honestly

Say which layers are an afternoon and which are not, and name anything the kit does **not** give
them. A status column and an approve route is small; a per-tenant approval *policy* engine is not.
If the feature wants something the kit has no seam for, say so plainly rather than designing around
it — `docs/CONCEPTS.md` "Known gaps" per section is where the honest limits are written down.

## 5. Write the plan down

Write `docs/features/<slug>.md` — the conversation is worthless once the session ends. Keep it to
what was decided, in their vocabulary:

```markdown
# <Feature>

**The slice.** <entity, states, who moves them — the three sentences from step 1>

**Permissions.** <subject, and the role → action rows to add to the CONCEPTS §1 matrix>

**Layers.** <each layer: destination path · the file to copy · how you know it works>

**App or plugin.** <which, and the one reason from step 0 that decided it; the plugin id if a plugin>

**Async / realtime / analytics.** <only the ones this slice needs, or "none">

**Traps that apply.** <from step 3, one line each>

**Open questions.** <what was not settled — never leave this out>
```

**Done when** the file exists and they have read it back. Tell them it is theirs: commit it, or
delete it once the feature ships.

## 6. Hand off — do not start building

Offer the next move with `AskUserQuestion`. The point of the plan file is that a fresh session can
act on it with a clean context window, so the choices are: **build the first layer** (a new session,
opened with the plan file — the contract, since everything else reads it), **walk another part of
the design** (a second slice, or the analytics half if you deferred it), or **stop here**.

**Whichever they pick, you do not write feature code in this skill.** If they ask you to start now,
say why a fresh session is better — this one is full of design conversation that the implementation
does not need — and hand them the plan path to open it with. If they insist, that is their call:
end this skill first, then work from the plan like any other request.

## A worked slice

`example-orders.md` beside this file is one complete slice — orders with an approval step and a
dashboard, **built as a plugin**, which is the default answer to step 0 — from the interview through
every layer to the traps. Read it when the person's feature resembles it, or when you want the shape
of a good answer. Its "Core location" column is in `docs/ADAPTING.md` §3 if the slice turns out to
belong in the app instead.
