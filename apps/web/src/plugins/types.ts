/**
 * The Worker half of a plugin (D31): what a plugin contributes to the server and to the UI.
 *
 * Both interfaces are generic over the plugin's `SharedPlugin` so that, once A2 opens the closed
 * sets, `jobHandlers` and `agents` can be checked for exhaustiveness against the keys that same
 * plugin declared — one plugin's missing handler is then a type error in the plugin, not a runtime
 * dispatch failure in the host.
 *
 * Fields marked (A2) are DECLARED but read by nothing yet: the registries they feed
 * (`JOB_TYPES`, `AGENT_KEYS`, `PROMPT_REGISTRY`, the CASL subjects, `FEATURES`, `buildAgentTools`,
 * `SCHEDULED_TASKS`, `RLS_EXCLUDED_TABLES`, the unscoped allow-list) are still closed sets and are
 * opened in the next PR. They are typed as loosely as they are honestly known: a precise-looking
 * type over a slot nothing reads would be a promise the host has not made.
 */

import type { SharedPlugin } from '@rocketflare/shared/plugins'
import type { Hono, MiddlewareHandler } from 'hono'
import type { ComponentType, LazyExoticComponent } from 'react'
import type { ScheduledTask } from '../api/scheduled'
import type { VisibilityResource } from '../api/services/access'
import type { Tool } from '../api/services/ai/kit'
import type { AppEnv } from '../api/types'
import type { Database } from '../db/client'
import type { Tenant } from '../db/schema'
import type { NavItem } from '../ui/components/SideNav'
import type { TabConfig } from '../ui/components/shared'
import type { NavGuard } from '../ui/hooks/useNavGuard'

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
  /** (A2) `type` → handler, for the job variants `shared.jobs` declares. */
  jobHandlers?: Readonly<Record<string, unknown>>
  /**
   * (A2) Agent definitions for the keys in `shared.agentKeys`.
   *
   * `unknown`, not `AnyAgentDefinition`: that type lives in `api/services/agents/**`, which is the
   * `feature-agents` SURFACE — an adopter may delete it, and the plugin seam itself must still
   * typecheck when they do. A2 owns the shape and has to pick one that survives that deletion:
   * either list this file in the surface's `registries[]` so the deletion is a decision somebody
   * takes, or declare a structural agent type outside the surface. The same applies to
   * `agentTools` below.
   */
  agents?: Readonly<Record<string, unknown>>
  /** (A2) Prompt registry entries for the keys in `shared.promptKeys`. */
  prompts?: Readonly<Record<string, unknown>>
  /**
   * (A2) Tools added to every agent run, beside the kit's knowledge tools. `Tool` is core
   * (`services/ai/kit.ts`), but its CONTEXT is not — `AgentToolContext` is inside `feature-agents`
   * — so the parameter is `never` here: a concrete `(ctx: AgentToolContext) => Tool[]` is
   * assignable to it, and the host cannot call it, which is exactly the state of a slot nothing
   * reads yet. A2 replaces this with a real context type (see `agents` above).
   */
  agentTools?: (ctx: never) => Tool[]
  /** (A2) Cron expression → tasks, merged into `SCHEDULED_TASKS`. Also needs both tomls. */
  scheduledTasks?: Readonly<Record<string, ScheduledTask[]>>
  /** (A2) Per-role CASL rules, applied after the kit's own matrix. */
  grants?: Readonly<Record<string, unknown>>
  /** (A2) Plugin tables with no `tenant_id`, for `RLS_EXCLUDED_TABLES`. */
  rlsExcludedTables?: readonly string[]
  /** (A2) Functions the cross-tenant allow-list scan may skip, each with a written reason. */
  unscopedAllowlist?: readonly string[]
  /** D29: rows of this plugin that a group may restrict. Read by `services/access.ts`. */
  visibilityResources?: readonly VisibilityResource[]
  hooks?: {
    /** Post-commit, best-effort, per plugin try/caught — exactly like the kit's own hooks. */
    onTenantCreated?: (db: Database, tenant: Tenant, userId: string) => Promise<void>
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
  /** Families merged into `queryKeys`; every root must start with `<id>:`. */
  queryKeys?: Readonly<Record<string, unknown>>
  /** (A2) `AGENT_FORMS` entries for the agents this plugin registers. */
  agentForms?: Readonly<Record<string, unknown>>
}

/** The element type of the barrels — a plugin whose shared half is not narrowed. */
export type AnyServerPlugin = ServerPlugin<SharedPlugin>
export type AnyUiPlugin = UiPlugin<SharedPlugin>
