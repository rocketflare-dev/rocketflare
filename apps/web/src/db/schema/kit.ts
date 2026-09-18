/**
 * The schema kit (D31) — the build-time symbols a plugin's table file needs at MODULE scope.
 *
 * **This is one of the two things that cannot be injected.** Every other kit capability reaches a
 * plugin through an execution context, but a `pgTable(...)` call runs when the module is
 * evaluated, long before any request, job or run exists. drizzle-kit then reads those tables
 * statically to generate DDL. So these six symbols have to be importable, and this file is where
 * they are declared to be.
 *
 * **Why it sits here, beside `rls.ts`, and not somewhere tidier.** `rls.ts` documents the cycle
 * this file has to stay out of: `rls.ts → plugins/server.ts → <plugin>/index.ts → db/schema →
 * rls.ts`. A module that a plugin's SCHEMA imports is as far upstream as anything in the app gets,
 * so it must read neither the plugin barrel nor `db/schema/index.ts` — which re-exports
 * `plugins/schema.ts`, which re-exports every installed plugin. Hence the imports below name
 * individual FILES.
 *
 * **It is deliberately not in `db/schema/index.ts`.** Every line of that barrel is an `export *`
 * over a table file, and drizzle-kit reads it as the schema; a re-export layer in there earns
 * nothing and invites an ambiguous name. Nothing is lost — a plugin imports this module directly.
 *
 * The kit tables here serve two distinct needs, and the second was missed at first. `tenants`,
 * `users` and `groups` are **FK and relation targets** — what a plugin's own table points AT.
 * `activityEvents`, `tenantUsers`, `groupTypes` and `groupMembers` are **query targets**: a plugin
 * that aggregates the kit's own rows (a cube, a fact table, a report) names them at module scope,
 * where no context exists yet and `allTables()` cannot be called. Both are legitimate; neither is a
 * licence to reach for a kit table that is not on this list, because that is what the injected
 * contexts are for.
 *
 * `groupMembers` is the one that arrived last and reads as the odd one out. It is here because a
 * plugin's own tenant-isolation and visibility TESTS have to put somebody in a group to prove the
 * predicate narrows — which they were doing through `allTables()`, the widest accessor in the
 * surface, for a table whose name they already knew. A declared name is the narrower answer.
 *
 * Note the rule that goes with all of them: **a plugin declares `relations()`
 * for its OWN tables only.** On drizzle-orm 0.45.2 a second `relations()` for a core table merges
 * at runtime but not at the type level, and silently strips `with:` from that table's query results
 * app-wide (`apps/web/src/plugins/schema.ts` has the measurement). The `one()` side on the plugin's
 * own table expresses the FK fully; only the `many()` back-reference is unavailable.
 */

export { RESOURCE_VISIBILITY_VALUES, tenantRef, timestamps } from './_helpers'
export { activityEvents } from './activity-events'
export { groupMembers, groups, groupTypes } from './groups'
export { membershipIsolation, tenantIsolation } from './rls'
export { tenantUsers } from './tenant-users'
export { tenants } from './tenants'
export { users } from './users'
