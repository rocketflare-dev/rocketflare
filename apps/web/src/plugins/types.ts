/**
 * The Worker half of a plugin (D31): what a plugin contributes to the server and to the UI.
 *
 * Both interfaces are generic over the plugin's `SharedPlugin` so that `jobHandlers`, `agents` and
 * `prompts` are checked for exhaustiveness against the keys that same plugin declared — one
 * plugin's missing handler is a type error in the plugin, not a runtime dispatch failure in the
 * host. The host's side of the same bargain is the merged table's cast: each half is checked where
 * it is declared, and only the join is asserted.
 *
 * **This file names the agent runtime, which is a deletable surface.** `AnyAgentDefinition`,
 * `AgentToolContext` and `AgentForm` all live inside `feature-agents`, so this file is listed in
 * that surface's `registries[]` in `.rocketflare.json`: an adopter who deletes the agent runtime
 * deletes the four fields below too, exactly as they already delete lines from `worker.ts`,
 * `api/index.ts` and `App.tsx`. The alternative — restating a structural agent type here so the
 * seam survives on its own — was rejected because it buys nothing: the real types are what makes
 * `agents: Record<AgentKeyOf<S>, …>` an exhaustiveness check rather than a shape a plugin can get
 * subtly wrong, and a restated one would be a second definition to keep in step.
 */

import type { PromptDefinition } from '@rocketflare/shared/ai/prompts'
import type { JobType } from '@rocketflare/shared/jobs'
import type { EffectiveRole } from '@rocketflare/shared/permissions'
import type { AgentKeyOf, JobTypeOf, PromptKeyOf, SharedPlugin } from '@rocketflare/shared/plugins'
import type { Hono, MiddlewareHandler } from 'hono'
import type { ComponentType, LazyExoticComponent } from 'react'
import type { JobHandler } from '../api/queues/jobs'
import type { ScheduledTask } from '../api/scheduled'
import type { VisibilityResource } from '../api/services/access'
import type { AnyAgentDefinition } from '../api/services/agents/registry'
import type { AgentToolContext } from '../api/services/agents/tools'
import type { Tool } from '../api/services/ai/kit'
import type { AppBindings, AppEnv } from '../api/types'
import type { Database } from '../db/client'
import type { Tenant } from '../db/schema'
import type { RoleGrant } from '../permissions/abilities'
import type { NavItem } from '../ui/components/SideNav'
import type { TabConfig } from '../ui/components/shared'
import type { NavGuard } from '../ui/hooks/useNavGuard'
import type { AgentForm } from '../ui/pages/agents/forms'
import type { QuickLink } from '../ui/pages/Home'

/** One entry of the mount table in `api/index.ts`: prefix, router, optional gate. */
export type PluginMount = readonly [string, Hono<AppEnv>, MiddlewareHandler?]

/** What `pnpm plugin check` verifies before an install, mirrored from the plugin's manifest. */
export interface PluginRequires {
  /** A semver range over the kit version, e.g. `">=0.5.0 <1.0.0"`. */
  kit?: string
  /** Surface ids that must still be present in the host (`feature-agents`…). */
  surfaces?: readonly string[]
  /** `"knowledge >=1.0.0 <2.0.0"` — id and range in one string; `parseNote` has no maps. */
  plugins?: readonly string[]
}

/** Everything a plugin's `seedDemo` hook is given (`pnpm seed --demo`). */
export interface PluginSeedContext {
  tenantId: string
  ownerId: string
  /**
   * A fixed uuid for a demo row, already namespaced with the plugin's id — so two plugins that
   * both seed `note:1` cannot collide, and re-running the seed adds nothing.
   */
  demoId: (key: string) => string
  log: (line: string) => void
}

export interface ServerPlugin<S extends SharedPlugin = SharedPlugin> {
  shared: S
  requires?: PluginRequires
  /** Spread into the mount table of `api/index.ts`; the prefix is `/api/<id>` by convention. */
  mounts?: readonly PluginMount[]
  /**
   * Extra path prefixes the Worker owns, unioned into `API_PREFIXES` — so an unmatched path under
   * one is a JSON 404 rather than `index.html`. Adding one ALSO means adding it to
   * `run_worker_first` in both tomls by hand; the parity test is what catches a forgotten one.
   */
  apiPrefixes?: readonly string[]
  /**
   * `type` → handler, covering EXACTLY the job variants `shared.jobs` declares. Merged into the
   * consumer's dispatch table; each handler gets its own DB client and awaits everything, like the
   * kit's own (there is no `waitUntil` in a queue consumer).
   */
  jobHandlers?: { [T in JobTypeOf<S> & string]: JobHandler<Extract<T, JobType>> }
  /** Agent definitions, one per key in `shared.agentKeys`. */
  agents?: { [K in AgentKeyOf<S> & string]: AnyAgentDefinition }
  /** Prompt registry entries, one per key in `shared.promptKeys`. */
  prompts?: { [K in PromptKeyOf<S> & string]: PromptDefinition }
  /**
   * Tools added to every agent run, beside the kit's three knowledge tools. Bound to the run's
   * access scope, so a plugin tool reads what its REQUESTER may read and nothing more. May be
   * async, and may return `[]` — that is how a tool is offered only to the tenants that turned it
   * on (read the plugin's own settings row for `ctx.scope.tenantId`). A builder that throws is
   * logged and skipped, never fatal to the run.
   */
  agentTools?: (ctx: AgentToolContext) => Tool[] | Promise<Tool[]>
  /**
   * Cron expression → tasks, merged into `SCHEDULED_TASKS` (tasks on a cron the kit already runs
   * are appended after the kit's). A cron the kit does NOT run must also be added to `[triggers]`
   * in BOTH tomls by hand — the parity test is what catches a forgotten one.
   */
  scheduledTasks?: Readonly<Record<string, ScheduledTask[]>>
  /** Per-role CASL rules, applied after the kit's own matrix — additive, never a replacement. */
  grants?: Partial<Record<EffectiveRole, RoleGrant>>
  /** Plugin tables with no `tenant_id`, unioned into `RLS_EXCLUDED_TABLES` with a reason each. */
  rlsExcludedTables?: readonly string[]
  /**
   * Source files the cross-tenant allow-list scan may skip, keyed the way that test keys its own:
   * a path relative to `apps/web/` (`src/plugins/<id>/…`) mapped to the REASON it is correct.
   */
  unscopedAllowlist?: Readonly<Record<string, string>>
  /** D29: rows of this plugin that a group may restrict. Read by `services/access.ts`. */
  visibilityResources?: readonly VisibilityResource[]
  hooks?: {
    /**
     * Post-commit, best-effort, per plugin try/caught — exactly like the kit's own hooks were.
     *
     * `features` is the set this DEPLOYMENT ships (D30), passed because a plugin that seeds rows
     * for a gated surface must not seed them where the surface does not exist: a hook that CREATES
     * rows is the sharpest feature door there is, and it has no nav entry to hide behind.
     */
    onTenantCreated?: (
      db: Database,
      tenant: Tenant,
      userId: string,
      features: readonly string[]
    ) => Promise<void>
    /**
     * A tenant has been deleted: drop whatever of its state lives OUTSIDE Postgres. Run from the
     * `tenant.purge` job (D7), per plugin, each in its own try/catch — post-commit, idempotent and
     * best-effort, exactly like `onTenantCreated`. There is no `Tenant` to hand over: the row and
     * everything `tenantRef()` cascades from it are already gone, which is why this takes the id.
     *
     * A plugin's TABLES need nothing here — the cascade took them. What needs this is R2 objects
     * (the kit purges its own `tenants/<id>/` prefix), KV keys and Durable Object state.
     *
     * **Durable Object state is purgeable only because instance names are derived.** There is no
     * API that enumerates the instances of a namespace, so state is reachable only where the KEYS
     * are known: derive every instance name from the tenant id, keep the set FINITE, and loop the
     * names this plugin DECLARES rather than trying to discover instances. `NotificationsHub` is
     * already that shape — `idFromName(tenantId)`, one instance per tenant — and a plugin that
     * wants one DO per row cannot be purged under this rule. The escape hatch for that case is a
     * purge-intent ledger: a table carrying `tenant_id` with NO foreign key, so it survives the
     * cascade and still names the rows to visit (`access_requests.requested_tenant_id` and
     * `user_sessions.selected_tenant_id` are the precedent for a tenant reference that outlives the
     * tenant). It is **deferred until somebody needs it** and deliberately not built.
     *
     * `env` is here for exactly those bindings; a plugin reaches its own KV or DO namespace
     * through it, never through a module-level global.
     */
    onTenantDeleted?: (db: Database, tenantId: string, env: AppBindings) => Promise<void>
    /** `pnpm seed --demo`, after the kit's own block. Fixed ids + `onConflictDoNothing`. */
    seedDemo?: (db: Database, ctx: PluginSeedContext) => Promise<void>
  }
  /**
   * Cross-plugin registries (D31 decision 6): the analytics plugin reads `extensions.cubes` and
   * friends from every installed plugin and narrows them with zod, failing loudly on anything it
   * cannot parse. `unknown[]` at the core boundary is the point — the kit stays ignorant of what
   * any plugin means by a "cube".
   */
  extensions?: Readonly<Record<string, readonly unknown[]>>
}

export type PluginRouteTier = 'shell' | 'noTenant' | 'public'

export interface PluginRoute {
  /** A path under the tier's router — `/approvals`, `/approvals/:id`. */
  path: string
  /**
   * `lazy(() => import('./ui/pages/Something'))` and nothing else. A plugin's pages must not ride
   * in the main bundle, and `tests/config/plugins.test.ts` checks the source for it.
   */
  Component: LazyExoticComponent<ComponentType>
  /** The SAME guard its nav item uses, so a link never points at a page its reader cannot open. */
  guard?: NavGuard
  /** Default `shell` — inside `Layout`, signed in with a tenant. */
  tier?: PluginRouteTier
}

/** A nav group, placed relative to a named core group ("Organisation" by default). */
export interface PluginNavGroup {
  label?: string
  /** Insert before the core group with this label; appended when the label is not found. */
  before?: string
  items: NavItem[]
}

export interface UiPlugin<S extends SharedPlugin = SharedPlugin> {
  shared: S
  routes: readonly PluginRoute[]
  nav?: readonly PluginNavGroup[]
  /** Extra `/settings?tab=` tabs, appended after the kit's. `can` is the caller's ability. */
  settingsTabs?: (ctx: { can: (action: string, subject: string) => boolean }) => TabConfig[]
  /**
   * Quick links for the Home page, merged AHEAD of the kit's own (D31). A feature somebody reaches
   * from Home is one they were told about; a plugin that only adds a nav item is one they have to
   * find. Each link carries the SAME guard object as its route, so Home can never offer a door the
   * page refuses — `useNavGuard` filters these exactly as it filters the nav.
   *
   * The host does NOT de-duplicate or re-order: two plugins offering the same `to` show twice.
   */
  homeLinks?: readonly QuickLink[]
  /** Families merged into `queryKeys`; every root must start with `<id>:`. */
  queryKeys?: Readonly<Record<string, unknown>>
  /**
   * `AGENT_FORMS` entries for the agents this plugin registers. Optional per agent: `formFor`
   * falls back to a form generated from the agent's own JSON Schema, then to a JSON textarea.
   */
  agentForms?: Readonly<Partial<Record<AgentKeyOf<S> & string, AgentForm>>>
}

/** The element type of the barrels — a plugin whose shared half is not narrowed. */
export type AnyServerPlugin = ServerPlugin<SharedPlugin>
export type AnyUiPlugin = UiPlugin<SharedPlugin>
