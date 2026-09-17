# A worked slice: orders with an approval step, as a plugin

One complete answer, end to end, for a feature that touches almost every layer the kit has. Use it
for its **shape**, not its nouns — the questions asked, the order taken, the traps named. Someone
adding tickets, expenses, bookings or reviews gets the same walk with different words.

It is built as a **plugin** (`orders`), which is the default answer to step 0: a resource with its
own table, its own screens and its own jobs is a tree you can lift out, version and install
somewhere else. The layers, their order and the traps are identical in core — only the destination
column changes, and `docs/ADAPTING.md` §3 has both.

## What the person said

> "I want to create orders, approve them, and see dashboards."

Three features in one sentence, and none of them designed yet. The interview turns it into a slice.

## App or plugin? (step 0)

Orders are not the kit's own tables, not auth, not tenancy, not a cross-cutting middleware — so
plugin, and the decision is that short. Two consequences settled before any file is named: the id is
**`orders`**, which namespaces everything (`orders_*` tables, `orders.decided` job type,
`/api/orders`, query-key roots `orders:…`, the `orders` CLI command); and the repository is
`rocketflare-plugin-orders`, installed with `pnpm plugin add` and upgraded with
`pnpm plugin upgrade` (`/rf-plugin`), shipping **no migration** — the host generates it.

## The interview (step 1)

**What is an order, and who owns it?** — A purchase request raised inside one organisation. It
belongs to the organisation, and it remembers who raised it. That is `tenantId` on the table plus a
`requestedByUserId` column; the tenant predicate is the security boundary, the user column is only
"whose is it".

**What states, and what moves it?** — `draft → submitted → approved | rejected`, and an approved
order can be `cancelled`. Drawing this out is the whole design: without it you get a table with a
free-text `status` and no rules.

**Who does what?** — A member raises and submits their own; an admin approves or rejects anyone's;
everyone in the organisation can read. That is a permission design, and it is why "approve" is not
just an `if` inside the update handler.

**What must not happen on the request?** — The email to the requester when a decision lands.

**What gets counted?** — Orders per week by status, and approval turnaround. That means the slice
does not end at a page; it continues into analytics.

**Live?** — The approvals queue should refresh when a colleague approves something. One nudge.

**The slice, read back:** *An order is raised by a member inside one organisation and moves
draft → submitted → approved or rejected, with cancellation after approval. Members raise and submit
their own; admins decide. Decisions email the requester, refresh every open queue, and feed a
dashboard of volume and turnaround.*

## The layers (step 2)

Four published entry files are the plugin's whole API — `packages/shared/src/plugins/orders/index.ts`
(the shared entry, imported as `@rocketflare/shared/plugins/orders/index`, and that `/index` is
load-bearing), `apps/web/src/plugins/orders/index.ts`, `.../orders/ui/index.ts` and
`apps/cli/src/plugins/orders/index.ts`. Everything below them is private; nothing in core may reach
past them. `apps/web/src/plugins/example-feature/` is the shape to copy for all four.

| Layer | Where it goes in the plugin | The slot it feeds | Copy from | Green when |
|---|---|---|---|---|
| Contract | `packages/shared/src/plugins/orders/index.ts` — `orderSchema`, `createOrderRequestSchema`, `orderDecisionRequestSchema`, `orderListQuerySchema` (extends `paginationQuerySchema`), `ORDER_STATUSES` as the single source both the enum and the UI read | the shared entry itself | `packages/shared/src/plugins/example-feature/index.ts` | `pnpm typecheck` |
| Subject + flag | the same file | `SharedPlugin.subjects` (`Order`), `SharedPlugin.features` if it ships dark first | the same file | `pnpm web test:config` |
| Schema | `apps/web/src/plugins/orders/db/schema/orders.ts` — `id`, `...tenantRef()`, `requestedByUserId`, `status` (`pgEnum`), `decidedByUserId`, `decidedAt`, `...timestamps()`, `tenantIsolation('orders_orders')`; re-exported from the plugin's `db/schema/index.ts` | one `export *` in `apps/web/src/plugins/schema.ts` (written by `pnpm plugin add`) | `apps/web/src/plugins/example-feature/db/schema/example-notes.ts` | `pnpm db:generate --name plugin-orders-<version>`, **read the SQL**, `pnpm db:migrate` |
| Permissions | `apps/web/src/plugins/orders/index.ts` | `ServerPlugin.grants` — additive rules after the kit's matrix | `example-feature`'s `grants` | the permission matrix test |
| Route | `apps/web/src/plugins/orders/api/routes.ts` — `createRouter()`, `validate()` with the shared schemas, `withAuthAndDb`, `guardPermission`. **The decision is its own route** (`POST /:id/decision`), not a `PATCH` that happens to set a status | `ServerPlugin.mounts` at `/api/orders` | `apps/web/src/plugins/example-feature/api/routes.ts` | the plugin's own `tests/api/orders.test.ts`, including the tenant-isolation assertion |
| Service | `apps/web/src/plugins/orders/api/orders.ts` — the transition rules live here, not in the handler: which status may follow which, who may make each move | (none — private to the plugin) | `apps/web/src/api/services/invitations.ts` (it queues and nudges, exactly like this one) | unit-tested through the route |
| Job | `orders.decided` in `SharedPlugin.jobs`, handler in `apps/web/src/plugins/orders/jobs/decided.ts` — or just enqueue the kit's existing `email.send` if the payload is an email and nothing more | `SharedPlugin.jobs` + `ServerPlugin.jobHandlers`, which is checked to cover **exactly** the variants this plugin declared | `apps/web/src/plugins/example-feature/jobs/ping.ts` | the message lands in `stubs(env).queue.messages` |
| Nudge | `nudge(realtime, realtimeEvent('entity.changed', tenantId, { entity: 'orders:order', id }))` in the service, **after** the transaction commits | nothing to register — `entity.changed` carries its own root | `services/invitations.ts` | `stubs(env).hub.broadcasts` |
| Hook + page | `apps/web/src/plugins/orders/ui/hooks/useOrders.ts`, `ui/pages/OrdersPage.tsx`; the page is `lazy(() => import(...))` in the UI entry | `UiPlugin.routes` + `UiPlugin.nav` + `UiPlugin.queryKeys` (roots `orders:…`, matching the nudge) | `apps/web/src/plugins/example-feature/ui/` | `pnpm web test:ui` |
| Cube | `apps/web/src/plugins/orders/cubes/orders.ts`, `where: eq(orders.tenantId, tenantIdOf(ctx))` | `ServerPlugin.extensions` — a plugin-owned registry the owning plugin narrows with zod; core stays ignorant of drizzle-cube | `api/cubes/activity-events.ts` | **a tenant-isolation case of its own** — two tenants, disjoint rows, in the plugin's tests |
| Fact table | `orders_daily_facts` only if the live cube gets slow. Grain `(tenant_id, day, status)`, `fact_refreshed_at` | the same `extensions` registry, plus a `ServerPlugin.scheduledTasks` entry if it refreshes on its own cron | `db/schema/facts/tenant-activity-daily-facts.ts` | `pnpm web db:refresh-facts && pnpm web db:check-facts` |
| Dashboard | a template in the plugin | the same `extensions` registry | `general-templates/tenant-overview` | the plugin's own template test |
| CLI (optional) | `apps/cli/src/plugins/orders/index.ts` over `api.ts`, parsing the same schema, `--json` | `CliPlugin.register(program, action)` — the top-level `orders` command | `apps/cli/src/plugins/example-feature/index.ts` | `pnpm --filter @rocketflare/cli test` |

Build it in that order and each layer has what it needs. The contract first is not ceremony: the
route, the page and the CLI all import it, so inventing a type in the route is the one shortcut that
reliably rots.

**Analytics is the one row that is not simply "the same place, elsewhere".** Cubes, fact tables and
dashboard templates reach the host through `ServerPlugin.extensions` rather than a typed slot,
because core deliberately knows nothing about drizzle-cube; the plugin that owns the registry is the
thing that narrows it with zod and fails loudly. Say that out loud rather than promising a slot that
does not exist.

## The traps that apply here (step 3)

- **`tenantIsolation('orders_orders')`** in `extraConfig`, or `rls-coverage.test.ts` fails the build
  — it treats a plugin table exactly like a kit table.
- **Every query filters `tenantId`**, including the decision route's lookup. Another organisation's
  order id must be a 404, and the test asserts it. **This is the one test a plugin with a table must
  carry**: tenant B can neither list, read nor delete tenant A's rows.
- **"Members see only their own" is an extra `userId` filter**, never a replacement for the tenant
  one. Dropping the tenant predicate because the user filter "already narrows it" is the classic way
  to leak.
- **Everything is namespaced by the id.** Tables `orders_*`, job type `orders.decided`, query-key
  roots `orders:…`, the prefix `/api/orders`, and any AG-UI CUSTOM event as `orders.` — **never
  `kit.`**, which is the kit's namespace and the one a third-party client may ignore.
- **Approve is a transition, not a field write.** Keep the legal moves in the service; a `PATCH`
  that accepts any status lets a member approve their own order with a crafted body.
- **The email is a job**, not an inline `await` in the decision route. A plugin's `jobHandlers` is
  checked for exhaustiveness against the variants its own `jobs` declared, so a missing handler is a
  type error here rather than a dispatch failure in the host.
- **The nudge entity string and the query-key root are the same string** — `orders:order` in the
  service nudge and in `UiPlugin.queryKeys`. Same string in both places or the UI never refreshes,
  and nothing errors to tell you.
- **`ui/index.ts` ships in the MAIN bundle**, for every reader, including the ones who never open
  Orders — so every page in it is `lazy(() => import(...))` and it imports only from the small
  allowlist `tests/config/plugins.test.ts` enforces.
- **Nothing under `packages/shared/src/plugins/orders/` imports `permissions.ts`, `jobs.ts`,
  `features.ts`, `realtime.ts` or `ai/agents.ts` at runtime.** Those five read the plugin barrel, so
  importing one back is a cycle that crashes at module evaluation rather than failing to compile.
  `import type { X } from` (whole declaration) is fine.
- **`relations()` for the plugin's OWN tables only.** A second `relations()` for a core table
  silently strips `with:` from that table's query results app-wide.
- **The cube's member names are frozen** the moment a dashboard stores them — `Orders.count` cannot
  be renamed later without breaking every saved page in every tenant.
- **The status `pgEnum` is append-only**, and so is every plugin release: **expand and contract,
  never rename.** drizzle-kit's rename prompt has no non-interactive answer, so a release that
  renames a column is a release nobody can apply unattended.
- **The plugin ships no migration and edits no toml.** The host runs `pnpm db:generate --name
  plugin-orders-<version>`; a declared binding, cron or `[vars]` key is written into both tomls by
  `pnpm provision cloudflare <env>`.

## Sizing (step 4)

Contract, schema, permissions, route, service, page: an afternoon each, less once the first is done.
The dashboard half is a second sitting, and worth deferring until real orders exist — a chart of
seeded data teaches you nothing. The plugin wrapper itself costs almost nothing on top: a manifest,
four entry files and `pnpm plugin add ../rocketflare-plugin-orders --local --apply` to develop it in
place inside a host.

What the kit does **not** give you: multi-step or conditional approval (two approvers, thresholds by
amount) is yours to design; there is no workflow engine behind `status`. Nor is there money —
currency, rounding and tax are application concerns the kit has no opinion on. And on the plugin
side: no third-party trust model (a plugin has full Worker and database access — installing one is
as trusting as merging a pull request), no cross-plugin foreign-key tooling, and no `many()`
back-reference from a core table onto `orders_orders`. Say all of it out loud rather than letting
someone discover it in week three.
