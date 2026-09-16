/**
 * The shared half of a plugin (D31).
 *
 * A plugin is a separate git repository COPIED into an app — never installed from npm, exactly
 * like the kit itself — that contributes contracts, routes, schema, UI and CLI commands through
 * five barrels. `SharedPlugin` is the part all three consumers see: the zod contracts, the keys it
 * owns, and the `[vars]` it needs.
 *
 * **This module never imports one of the five composers AT RUNTIME, and nor does a plugin's own
 * `index.ts`.** The five — `ai/agents.ts`, `jobs.ts`, `permissions.ts`, `features.ts`,
 * `realtime.ts` — read the plugin barrel to open their closed sets, so a plugin module importing
 * one of them back closes a cycle through `plugins/index.ts` and leaves one of the two sides
 * holding `undefined` at module-evaluation time.
 *
 * A RUNTIME import is the only kind that can do that, so a whole-declaration `import type` is
 * fine — which is why `FeatureDefinition` is imported from `../features` below rather than
 * restated: one definition of what a feature flag is, and no copy to drift. `import { type X }
 * from` is NOT fine: eliding every specifier leaves an empty import clause, and whether that
 * survives as a bare side-effect import is the bundler's decision rather than ours.
 * `apps/web/tests/config/shared-imports.test.ts` checks all three spellings.
 *
 * `JobVariant` is spelled locally, and not because of that rule: zod's own
 * `ZodDiscriminatedUnionOption<'type'>` IS the constraint `jobInputSchema` puts on a variant, so
 * naming it here rejects a malformed one where the plugin author is looking.
 *
 * Everything a plugin keys is namespaced with its `id` (tables `<id>_*`, job types `<id>.x`,
 * subjects, prompt/agent/feature keys, query-key roots `<id>:…`, the API prefix `/api/<id>`), so
 * two plugins installed in one app cannot collide and the host can always say which one owns a row.
 */
import type { TypeOf, ZodDiscriminatedUnionOption, ZodRawShape } from 'zod'
import type { FeatureDefinition } from '../features'

/**
 * `^[a-z][a-z0-9-]*$` and never containing `rocketflare`: a plugin is written in the kit's
 * vocabulary so `scripts/rename.mjs` can translate it into a renamed app on the way in, and an id
 * carrying the kit's name would be rewritten with everything else.
 */
export const PLUGIN_ID_RE = /^[a-z][a-z0-9-]*$/

export function isPluginId(value: string): boolean {
  return PLUGIN_ID_RE.test(value) && !value.includes('rocketflare')
}

/** `<id>:` — the prefix every query-key root and demo-seed id a plugin owns must carry. */
export function pluginNamespace(id: string): string {
  return `${id}:`
}

/**
 * One job envelope variant: a zod object whose `type` is the discriminant. Spelled as zod's own
 * discriminated-union option type, so a variant that would not compose into `jobInputSchema` is
 * rejected here, where the plugin author is looking.
 */
export type JobVariant = ZodDiscriminatedUnionOption<'type'>

export interface SharedPlugin {
  /** Matches `PLUGIN_ID_RE`; the namespace for everything below. */
  readonly id: string
  /** Human name, for the plugin list and the install plan. */
  readonly label: string
  /** The plugin's own semver, mirrored from its `rocketflare-plugin.json`. */
  readonly version?: string
  /**
   * Agent keys this plugin registers — `AGENT_KEYS = [...CORE_AGENT_KEYS, ...plugins]`. Declared
   * here rather than server-side because the UI and the CLI validate agent input against the same
   * enum. Write it `as const` (the barrel is `as const satisfies …`), or the keys widen to `string`
   * and `agentKeySchema` stops naming them.
   */
  readonly agentKeys?: readonly string[]
  /** Prompt registry keys this plugin owns; `ServerPlugin.prompts` must cover exactly these. */
  readonly promptKeys?: readonly string[]
  /**
   * Job envelope variants as DATA: `jobInputSchema` is a discriminated union over
   * `[...CORE_JOB_VARIANTS, ...plugin variants]`. Namespace every `type` with the plugin's id
   * (`orders.sync`), and remember the kit's own rule — the `type` string is the version seam, so a
   * breaking payload change is a new variant, never an edited one.
   */
  readonly jobs?: readonly JobVariant[]
  /**
   * CASL subjects this plugin adds, unioned into `Subjects`. A subject is a NOUN the plugin owns
   * (`Order`), and the rules that grant it live in `ServerPlugin.grants`.
   */
  readonly subjects?: readonly string[]
  /**
   * Feature-flag definitions keyed by flag key (D30), merged into `FEATURE_FLAGS`. A flag is
   * configuration, not a permission: gate with `hasFeature(auth.features, …)`, never with CASL.
   */
  readonly features?: Readonly<Record<string, FeatureDefinition>>
  /**
   * Extra `[vars]` / secrets, merged into the Worker's config schema (`apps/web/src/config.ts`).
   * A zod raw shape rather than a whole object so the kit's schema stays one schema.
   */
  readonly config?: ZodRawShape
  /**
   * Query-key roots that `access.changed` should invalidate (D29): a plugin whose rows carry
   * `visibility` has to be re-fetched when somebody's group membership moves under them.
   */
  readonly realtimeRoots?: readonly string[]
}

// ---- Derivations the host's closed sets read ------------------------------------------------

/** The agent keys one plugin declares — what its `ServerPlugin.agents` must cover, exhaustively. */
export type AgentKeyOf<S extends SharedPlugin> = NonNullable<S['agentKeys']>[number]

/** The prompt keys one plugin declares — what its `ServerPlugin.prompts` must cover. */
export type PromptKeyOf<S extends SharedPlugin> = NonNullable<S['promptKeys']>[number]

/** The CASL subjects one plugin declares. */
export type SubjectOf<S extends SharedPlugin> = NonNullable<S['subjects']>[number]

/** The feature keys one plugin declares (the keys of its `features` record). */
export type FeatureKeyOf<S extends SharedPlugin> = Extract<keyof NonNullable<S['features']>, string>

/** The job types one plugin declares — what its `ServerPlugin.jobHandlers` must cover. */
export type JobTypeOf<S extends SharedPlugin> = TypeOf<NonNullable<S['jobs']>[number]>['type']
