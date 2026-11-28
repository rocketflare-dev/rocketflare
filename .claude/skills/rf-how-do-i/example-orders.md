# A worked slice: orders with an approval step, as a domain

<!-- agent-docs-check: hypothetical — every orders path below is what you would create -->

One complete answer, end to end, for a feature that touches almost every layer the kit has. Use it
for its **shape**, not its nouns — the questions asked, the order taken, the traps named. Someone
adding tickets, expenses, bookings or reviews gets the same walk with different words.

It is built as an **app domain** (`orders`), because orders are this app's own concept and logic:
nobody installs "our purchase orders" in another app. The layers, their order and the traps are
the same for a plugin or for core; only the destination changes, and `docs/ADAPTING.md` §3 has all
three.

## What the person said

> "I want to create orders, approve them, and see dashboards."

Three features in one sentence, and none of them designed yet. The interview turns it into a slice.

## Domain, plugin or core? (step 0)

No published plugin does purchase orders. Orders are not the kit's own tables, not auth, not
tenancy, not a cross-cutting middleware, so not core. They are this organisation's own process, so
a domain, not a plugin, and the decision is that short. Two consequences settled before any file is
named: the id is **`orders`**, which namespaces everything (`orders_*` tables, `orders.decided` job
type, `orders.order.decided` event, `/api/orders`, query-key roots `orders:…`, the `orders` CLI
command); and it is written in place in this repository, listed by hand in the five app lists, with
its migration generated like the kit's own.

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

Three trees and five list lines are the whole domain: `packages/shared/src/orders/index.ts` (the
contracts, imported as `@rocketflare/shared/orders/index`, and that `/index` is load-bearing),
`apps/web/src/orders/` (`index.ts` with `defineDomain`, `server/`, `ui/`, `db/schema.ts`) and
`apps/cli/src/orders/`, listed in `apps/web/src/app.ts`, `app-ui.ts`, `app-schema.ts`,
`packages/shared/src/app.ts` and `apps/cli/src/app.ts`. Everything under the trees is private to
the domain; another domain that needs orders gets one `apps/web/src/orders/public.ts` and lists
`orders` in its `dependsOn`. `apps/web/src/example-hr/` is the shape to copy: its leave request is
an approval, like this one.

| Layer | Where it goes in the domain | The slot it feeds | Copy from | Green when |
|---|---|---|---|---|
| Contract | `packages/shared/src/orders/index.ts` — `orderSchema`, `createOrderRequestSchema`, `orderDecisionRequestSchema`, `orderListQuerySchema` (extends `paginationQuerySchema`), `ORDER_STATUSES` as the single source both the enum and the UI read | the shared half (`SharedDomain`), one line in `packages/shared/src/app.ts` | `packages/shared/src/example-hr/index.ts` | `pnpm typecheck` |
| Subject, flag, event | the same file | `subjects` (`Order`), `features` if it ships dark first, `events` (`orders.order.decided`, a zod payload) | the same file | `pnpm web test:config` |
| Schema | `apps/web/src/orders/db/schema.ts` — `id`, `...tenantRef()`, `requestedByUserId`, `status` (`pgEnum`), `decidedByUserId`, `decidedAt`, `...timestamps()`, `tenantIsolation('orders_orders')` | one `export *` line in `apps/web/src/app-schema.ts` | `apps/web/src/example-hr/db/schema.ts` | `pnpm db:generate`, **read the SQL**, `pnpm db:migrate` |
| Permissions | `apps/web/src/orders/index.ts` | `grants` in `defineDomain` — additive rules after the kit's matrix | `example-hr`'s `grants` | the permission matrix test |
| Route | `apps/web/src/orders/server/routes.ts` — `createRouter()`, `validate()` with the shared schemas, `withAuthAndDb`, `guardPermission`. **The decision is its own route** (`POST /:id/decision`), not a `PATCH` that happens to set a status | `mounts` at `/api/orders` | `apps/web/src/example-hr/server/routes.ts` | `apps/web/tests/orders/api/orders.test.ts`, including the tenant-isolation assertion |
| Service | `apps/web/src/orders/server/orders.ts` — the transition rules live here, not in the handler: which status may follow which, who may make each move; it emits `orders.order.decided` after the row is stored | (none — private to the domain) | `apps/web/src/example-hr/server/leave.ts` (an approval's rules; its `routes.ts` emits the event) | tested through the route |
| Job | `orders.decided` in the shared `jobs`, handler in `apps/web/src/orders/server/decided.ts` — or just enqueue the kit's existing `email.send` if the payload is an email and nothing more | `jobs` + `jobHandlers`, which is checked to cover **exactly** the variants this domain declared | `apps/web/src/plugins/example-feature/jobs/ping.ts` (the shape is the same in a domain) | the message lands in `stubs(env).queue.messages` |
| Nudge | `nudge(realtime, realtimeEvent('entity.changed', tenantId, { entity: 'orders:order', id }))` in the service, **after** the transaction commits | nothing to register — `entity.changed` carries its own root | `services/invitations.ts` | `stubs(env).hub.broadcasts` |
| Hook + page | `apps/web/src/orders/ui/hooks/useOrders.ts`, `ui/pages/OrdersPage.tsx`; the page is `lazy(() => import(...))` in `ui/index.ts` | `defineDomainUi` `routes` + `nav` + `queryKeys` (roots `orders:…`, matching the nudge), one line in `app-ui.ts` | `apps/web/src/example-hr/ui/` | `pnpm web test:ui` |
| Cube | `apps/web/src/orders/server/cubes.ts`, `where: eq(orders.tenantId, tenantIdOf(ctx))` | `extensions: analyticsExtensions({ cubes, cubeIsolationCases })`, imported from the analytics plugin's published entry; core stays ignorant of drizzle-cube | `api/cubes/activity-events.ts` | **a tenant-isolation case of its own** — two tenants, disjoint rows |
| Fact table | `orders_daily_facts` only if the live cube gets slow. Grain `(tenant_id, day, status)`, `fact_refreshed_at` | the same `extensions` registry, plus a `scheduledTasks` entry on a cron both tomls already trigger | the analytics plugin's `db/schema/facts/` | `rocketflare analytics refresh-facts && rocketflare analytics check-facts` |
| Dashboard | a template in the domain | the same `extensions` registry | `general-templates/tenant-overview` | its own template test |
| CLI (optional) | `apps/cli/src/orders/index.ts` over `requireClient`, parsing the same schema, `--json` | a `CliPlugin` (`register(program, action)`) — the top-level `orders` command, one line in `apps/cli/src/app.ts` | `apps/cli/src/example-sales/index.ts` | `pnpm --filter @rocketflare/cli test` |

Build it in that order and each layer has what it needs. The contract first is not ceremony: the
route, the page and the CLI all import it, so inventing a type in the route is the one shortcut that
reliably rots.

**Analytics is the one row that is not simply "the same place, elsewhere".** Cubes, fact tables and
dashboard templates reach the analytics plugin through `extensions` rather than a typed slot,
because core deliberately knows nothing about drizzle-cube; the plugin that owns the registry is the
thing that narrows it with zod and fails loudly. Say that out loud rather than promising a slot that
does not exist.

## The traps that apply here (step 3)

- **`tenantIsolation('orders_orders')`** in `extraConfig`, or `rls-coverage.test.ts` fails the build
  — it treats a domain's table exactly like a kit table.
- **Every query filters `tenantId`**, including the decision route's lookup. Another organisation's
  order id must be a 404, and the test asserts it. **This is the one test a unit with a table must
  carry**: tenant B can neither list, read nor delete tenant A's rows.
- **"Members see only their own" is an extra `userId` filter**, never a replacement for the tenant
  one. Dropping the tenant predicate because the user filter "already narrows it" is the classic way
  to leak.
- **Everything is namespaced by the id.** Tables `orders_*`, job type `orders.decided`, query-key
  roots `orders:…`, the prefix `/api/orders`, and any AG-UI CUSTOM event as `orders.` — **never
  `kit.`**, which is the kit's namespace and the one a third-party client may ignore.
- **Approve is a transition, not a field write.** Keep the legal moves in the service; a `PATCH`
  that accepts any status lets a member approve their own order with a crafted body.
- **The email is a job**, not an inline `await` in the decision route. A domain's `jobHandlers` is
  checked for exhaustiveness against the variants its own `jobs` declared, so a missing handler is a
  type error here rather than a dispatch failure at runtime.
- **Another domain reacts to the decision through the event**, not an import: a `budgets` domain
  that books an approved order handles `orders.order.decided` in its own `eventHandlers`. Only a
  synchronous read ("what is still awaiting approval?") goes through `orders/public.ts`, and then
  `budgets` lists `orders` in `dependsOn`. `tests/config/units.test.ts` fails an import past
  `public.ts`, an undeclared edge and a cycle.
- **The nudge entity string and the query-key root are the same string** — `orders:order` in the
  service nudge and in the UI half's `queryKeys`. Same string in both places or the UI never refreshes,
  and nothing errors to tell you.
- **`ui/index.ts` ships in the MAIN bundle**, for every reader, including the ones who never open
  Orders — so every page in it is `lazy(() => import(...))` and it imports only from the
  wiring half of the UI kit (`@/plugins/api/ui-wiring`).
- **Nothing under `packages/shared/src/orders/` imports `permissions.ts`, `jobs.ts`,
  `features.ts`, `realtime.ts` or `ai/agents.ts` at runtime.** Those five read the unit list, so
  importing one back is a cycle that crashes at module evaluation rather than failing to compile.
  `import type { X } from` (whole declaration) is fine.
- **`relations()` for the domain's OWN tables only.** A second `relations()` for a core table
  silently strips `with:` from that table's query results app-wide.
- **The cube's member names are frozen** the moment a dashboard stores them — `Orders.count` cannot
  be renamed later without breaking every saved page in every tenant.
- **The status `pgEnum` is append-only**: **expand and contract, never rename.** drizzle-kit's
  rename prompt has no non-interactive answer, so a release that renames a column is a release
  nobody can apply unattended.
- **A domain declares no new `/api` prefix outside `/api/orders` and no binding**: those need a
  plugin manifest. Its cron must be one both tomls already trigger.

## Sizing (step 4)

Contract, schema, permissions, route, service, page: an afternoon each, less once the first is done.
The dashboard half is a second sitting, and worth deferring until real orders exist — a chart of
seeded data teaches you nothing. The domain wrapper costs almost nothing on top: one
`defineDomain` call, one `defineDomainUi` call and five list lines.

What the kit does **not** give you: multi-step or conditional approval (two approvers, thresholds by
amount) is yours to design; there is no workflow engine behind `status`. Nor is there money —
currency, rounding and tax are application concerns the kit has no opinion on. And on the domain
side: no per-domain roles yet (an "approver" is a tenant role, so "admins approve" is the honest
first cut), no cross-unit foreign-key tooling, and no `many()` back-reference from a core table
onto `orders_orders`. Say all of it out loud rather than letting
someone discover it in week three.
