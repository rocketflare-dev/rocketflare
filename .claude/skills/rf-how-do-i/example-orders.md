# A worked slice: orders with an approval step

One complete answer, end to end, for a feature that touches almost every layer the kit has. Use it
for its **shape**, not its nouns — the questions asked, the order taken, the traps named. Someone
adding tickets, expenses, bookings or reviews gets the same walk with different words.

## What the person said

> "I want to create orders, approve them, and see dashboards."

Three features in one sentence, and none of them designed yet. The interview turns it into a slice.

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

| Layer | Where it goes | Copy from | Green when |
|---|---|---|---|
| Contract | `packages/shared/src/orders.ts` — `orderSchema`, `createOrderRequestSchema`, `orderDecisionRequestSchema`, `orderListQuerySchema` (extends `paginationQuerySchema`), `ORDER_STATUSES` as the single source both the enum and the UI read | `packages/shared/src/tenants.ts` | `pnpm typecheck` |
| Schema | `apps/web/src/db/schema/orders.ts` — `id`, `...tenantRef()`, `requestedByUserId`, `status` (`pgEnum`), `decidedByUserId`, `decidedAt`, `...timestamps()`, `tenantIsolation('orders')`; export from `schema/index.ts` | `apps/web/src/db/schema/files.ts` | `pnpm db:generate`, **read the SQL**, `pnpm db:migrate` |
| Permissions | `Order` subject in `apps/web/src/permissions/abilities.ts`; admin+ `manage`, member `read` + `create`, and the transitions route-scoped | the `File` rows in the same file | `pnpm web test:config` (the permission matrix test) |
| Route | `apps/web/src/api/routes/orders.ts` — `createRouter()`, `validate()` with the shared schemas, `withAuthAndDb`, `guardPermission`; mount in `api/index.ts` behind `authMiddleware`. **The decision is its own route** (`POST /:id/decision`), not a `PATCH` that happens to set a status | `apps/web/src/api/routes/files.ts` | `tests/api/orders.test.ts`, including the tenant-isolation assertion |
| Service | `apps/web/src/api/services/orders.ts` — the transition rules live here, not in the handler: which status may follow which, who may make each move | `services/invitations.ts` (it queues and nudges, exactly like this one) | unit-tested through the route |
| Job | `email.send` variant already exists — enqueue it on decision; a bespoke type only if the payload differs | `queues/handlers/` | the message lands in `stubs(env).queue.messages` |
| Nudge | `nudge(realtime, realtimeEvent('entity.changed', tenantId, { entity: 'order', id }))` in the service, **after** the transaction commits | `services/invitations.ts` | `stubs(env).hub.broadcasts` |
| Hook + page | `ui/hooks/useOrders.ts` with the family named `['order']` to match the nudge; `ui/pages/orders/`, lazy in `App.tsx`, `SideNav` behind the same guard as the page | any existing resource hook + page pair | `pnpm web test:ui` |
| Cube | `api/cubes/orders.ts`, `where: eq(orders.tenantId, tenantIdOf(ctx))`, registered in `allCubes` | `api/cubes/activity-events.ts` | **a case in `tests/api/cubes/cube-isolation.test.ts`** — not optional |
| Fact table | `orders_daily_facts` only if the live cube gets slow. Grain `(tenant_id, day, status)`, `fact_refreshed_at`, an entry in `FACT_TABLES` | `db/schema/facts/tenant-activity-daily-facts.ts` | `pnpm web db:refresh-facts && pnpm web db:check-facts` |
| Dashboard | a template in `src/dashboards/`, registered in `DASHBOARD_TEMPLATES` | `general-templates/tenant-overview` | `tests/dashboards/all-templates.test.ts` |
| CLI (optional) | `apps/cli/src/commands/orders.ts` over `api.ts`, parsing the same schema, `--json` | `commands/members.ts` | `pnpm --filter @rocketflare/cli test` |

Build it in that order and each layer has what it needs. The contract first is not ceremony: the
route, the page and the CLI all import it, so inventing a type in the route is the one shortcut that
reliably rots.

## The traps that apply here (step 3)

- **`tenantIsolation('orders')`** in `extraConfig`, or `rls-coverage.test.ts` fails the build.
- **Every query filters `tenantId`**, including the decision route's lookup. Another organisation's
  order id must be a 404, and the test asserts it.
- **"Members see only their own" is an extra `userId` filter**, never a replacement for the tenant
  one. Dropping the tenant predicate because the user filter "already narrows it" is the classic way
  to leak.
- **Approve is a transition, not a field write.** Keep the legal moves in the service; a `PATCH`
  that accepts any status lets a member approve their own order with a crafted body.
- **The email is a job**, not an inline `await` in the decision route.
- **The nudge entity string is `'order'` and so is the query-key family root.** Same string in both
  places or the UI never refreshes, and nothing errors to tell you.
- **The cube's member names are frozen** the moment a dashboard stores them — `Orders.count` cannot
  be renamed later without breaking every saved page in every tenant.
- **The status `pgEnum` is append-only.** A migration cannot use a value it adds in the same
  migration, and removing one is not a thing.

## Sizing (step 4)

Contract, schema, permissions, route, service, page: an afternoon each, less once the first is done.
The dashboard half is a second sitting, and worth deferring until real orders exist — a chart of
seeded data teaches you nothing.

What the kit does **not** give you: multi-step or conditional approval (two approvers, thresholds by
amount) is yours to design; there is no workflow engine behind `status`. Nor is there money —
currency, rounding and tax are application concerns the kit has no opinion on. Say both out loud
rather than letting someone discover them in week three.
