/**
 * The plugin API — the ONE module a plugin's server half imports from the host (D31).
 *
 * `import { requestCtx, createRouter, validate } from '@/plugins/api'` and that is the whole of it.
 * Everything a plugin needs at RUNTIME arrives through an injected context; everything it needs to
 * NAME (a `Database` in its own service signature, a `Tool`, an `AccessScope`) is a type re-exported
 * here. The enforcement rule in `tests/helpers/plugins.ts` is the sentence this file makes true:
 * *a plugin imports only from declared entries, and receives everything else as injected context.*
 *
 * The exports below are grouped by the file they come from and sorted by the formatter, so read
 * them there: `./http` is a request, `./jobs` is background work, `./ai` is agents and tools,
 * `./access` is row visibility, `./events` is nudges and notifications, `./secrets` is a tenant's
 * credentials at rest.
 *
 * **Three things are deliberately NOT here.**
 *
 * - `./peers` — `extensions()` and `allTables()` read the whole installed set, which means this
 *   module would read the plugin barrel, which every plugin imports. Keeping it out means the
 *   common path is acyclic; importing it is then a deliberate act with its own file to explain
 *   itself.
 * - `./ui` and `./ui-wiring` — React. A plugin's server half must never pull the browser half into
 *   the Worker bundle, and the two UI halves are separately importable for a reason of their own
 *   (one ships in the main bundle, one must not).
 * - Schema helpers. `tenantRef`, `timestamps` and `tenantIsolation` are needed at MODULE scope by a
 *   table file, so they can come neither from a context nor from a module that reads the plugin
 *   barrel. They are at `@/db/schema/kit` — beside `rls.ts`, below the barrel.
 */

export type {
  AnyServerPlugin,
  AnyUiPlugin,
  PluginNavGroup,
  PluginRequires,
  PluginRoute,
  PluginRouteTier,
  PluginSeedContext,
  ServerPlugin,
  UiPlugin,
} from '../types'
export type {
  AccessScope,
  ResourceGrantRow,
  SetResourceGroupsInput,
  VisibilityResource,
} from './access'
export { sharedWithMyGroups } from './access'
export type {
  AgentCtx,
  PluginAgent,
  PluginStructuredOptions,
  PluginToolLoopOptions,
  Tool,
  ToolApproval,
  ToolCtx,
  ToolLoopCheckpoint,
  ToolLoopResult,
} from './ai'
export {
  AiNotConfiguredError,
  agentCtx,
  defineTool,
  recordUsage,
  toolCtx,
  toolInputSchema,
} from './ai'
export type { AbilityCheck, Actions, MembershipRole, PluginAuth, Subjects, User } from './auth'
export { hasFeature, isAdminLevel, isGlobalAdmin, isOwnerLevel, requireFeature } from './auth'
export type { HookCtx, SeedCtx, Tenant } from './db'
export { transaction } from './db'
export type { ActivityInput, NotifyInput, Realtime } from './events'
export {
  durableObject,
  notify,
  notifyMany,
  nudge,
  nudgeEntity,
  nudgeUser,
  nudgeUsers,
  realtimeEvent,
  recordActivity,
} from './events'
export type {
  AppRouter,
  DetachedCtx,
  PluginMount,
  RequestCtx,
  RequestVisibility,
} from './http'
export { createRouter, pageWindow, requestCtx, validate } from './http'
export type {
  CronCtx,
  JobCtx,
  JobEnvelope,
  JobHandler,
  JobInput,
  JobOf,
  JobType,
  ScheduledTask,
} from './jobs'
export { cronCtx, jobCtx } from './jobs'
export type { AgentTraceContext, TraceHandle, Tracer } from './observability'
export { noopTracer, traceChatClient, tracingEnabled, withAgentTrace } from './observability'
export type { StepRealtime } from './realtime-step'
export { createStepRealtimeFor } from './realtime-step'
export { openSecret, sealSecret } from './secrets'
export type {
  Database,
  DatabaseHandle,
  Logger,
  PluginBindings,
  PluginConfig,
  PluginContext,
  PluginLogger,
} from './types'
export type { StepCtx, StepOptions, WorkflowCtx } from './workflow'
export { DuplicateStepNameError, workflowCtx } from './workflow'
