/**
 * The shared plugin API (D31) — what a plugin's CONTRACT module imports from the kit.
 *
 * A plugin's shared entry is the one of its four published files that all three consumers read, so
 * it is also the one with the strictest rule about what IT may read. Two constraints shape this
 * file:
 *
 * 1. **`packages/shared` may import only zod, its own siblings and two justified type-only
 *    dependencies.** It bundles into the browser AND loads in the CLI, so anything carrying a
 *    platform API breaks one of the two consumers.
 * 2. **Nothing under `src/plugins/**` may import one of the five composers AT RUNTIME** —
 *    `ai/agents.ts`, `jobs.ts`, `permissions.ts`, `features.ts`, `realtime.ts`. Those five read the
 *    plugin barrel to open their closed sets, so importing one back closes a cycle through
 *    `plugins/index.ts` — and two zod modules in a cycle do not fail to compile, they crash at
 *    module evaluation with one side holding `undefined`.
 *
 * So everything drawn from a composer below is a whole-declaration `export type`, which is erased
 * before anything evaluates. That is not a workaround: it is how `SharedPlugin.features` is typed
 * against the ONE `FeatureDefinition` rather than a restatement that drifts. `export { type X }`
 * would NOT do — eliding every specifier leaves an empty clause whose fate is the bundler's — and
 * `tests/config/shared-imports.test.ts` checks all three spellings.
 */

export type { ApiErrorBody, ErrorCode } from '../errors'
/** The error envelope every failure uses, including validation. Success bodies are bare. */
export { apiErrorSchema, ERROR_CODES } from '../errors'
// ---- types drawn from the five composers — type-only, always ------------------------------------
export type { FeatureDefinition, FeatureFlagState, FeatureRolloutUnit } from '../features'
export type { GroupRef, ResourceVisibility } from '../groups'
export type { JobInput, JobOf, JobType } from '../jobs'
export type { PaginationMeta, PaginationQuery } from '../pagination'
// ---- contracts a plugin builds its own schemas out of -------------------------------------------
//
// Not composers, so these are ordinary runtime imports. `paginatedResponse(itemSchema)` is the one
// list shape every consumer parses, and a plugin using anything else makes its CLI and its UI each
// write a parser the server never validated against.
export {
  paginatedResponse,
  paginationMeta,
  paginationMetaSchema,
  paginationQuerySchema,
} from '../pagination'
export type { Actions, Subjects } from '../permissions'
export type { RealtimeEvent, RealtimeEventType } from '../realtime'
export type { MembershipRole } from '../tenants'
// ---- the plugin interface itself ---------------------------------------------------------------
export type {
  AgentKeyOf,
  DeclaredBy,
  FeatureKeyOf,
  JobTypeOf,
  JobVariant,
  PromptKeyOf,
  SharedPlugin,
  SubjectOf,
} from './types'
export { isPluginId, PLUGIN_ID_RE, pluginNamespace } from './types'
