/**
 * The shared half of a plugin.
 *
 * A plugin is a separate git repository COPIED into an app — never installed from npm, exactly
 * like the app itself — that contributes contracts, routes, schema, UI and CLI commands through
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
 * `ZodObject<{ type: ZodTypeAny } & ZodRawShape>` IS the constraint `jobInputSchema` puts on a variant, so
 * naming it here rejects a malformed one where the plugin author is looking.
 *
 * Everything a plugin keys is namespaced with its `id` (tables `<id>_*`, job types `<id>.x`,
 * subjects, prompt/agent/feature keys, query-key roots `<id>:…`, the API prefix `/api/<id>`), so
 * two plugins installed in one app cannot collide and the host can always say which one owns a row.
 */
import type { TypeOf, ZodObject, ZodRawShape, ZodTypeAny } from 'zod'
import type { FeatureDefinition } from '../features'

/**
 * `^[a-z][a-z0-9-]*$` and never containing `rocketflare`: an id carrying the app's
 * original name would be rewritten with everything else when the app is renamed.
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
export type JobVariant = ZodObject<{ type: ZodTypeAny } & ZodRawShape>

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
   * (`orders.sync`), and remember the core rule — the `type` string is the version seam, so a
   * breaking payload change is a new variant, never an edited one.
   */
  readonly jobs?: readonly JobVariant[]
  /**
   * CASL subjects this plugin adds, unioned into `Subjects`. A subject is a NOUN the plugin owns
   * (`Order`), and the rules that grant it live in `ServerPlugin.grants`.
   */
  readonly subjects?: readonly string[]
  /**
   * Feature-flag definitions keyed by flag key, merged into `FEATURE_FLAGS`. A flag is
   * configuration, not a permission: gate with `hasFeature(auth.features, …)`, never with CASL.
   */
  readonly features?: Readonly<Record<string, FeatureDefinition>>
  /**
   * Extra `[vars]` / secrets, merged into the Worker's config schema (`apps/web/src/config.ts`).
   * A zod raw shape rather than a whole object so the core schema stays one schema.
   */
  readonly config?: ZodRawShape
  /**
   * Query-key roots that `access.changed` should invalidate: a plugin whose rows carry
   * `visibility` has to be re-fetched when somebody's group membership moves under them.
   */
  readonly realtimeRoots?: readonly string[]
  /**
   * Events this plugin EMITS (D42), name → payload schema. Every name is `<id>.<name>` — this
   * plugin's id, a dot, then lower-case segments (`sites.form.submitted`) — and never `kit.`.
   * `ctx.emit(name, …)` validates the payload against the schema and records the event;
   * `ServerPlugin.eventHandlers`, the app's own `APP_EVENT_HANDLERS` and an agent's `triggers` /
   * `bindable` subscribe to it by name. A payload may hold personal data (a form's fields): it is
   * kept for `EVENTS_RETENTION_DAYS` and never logged. Write it `as const` so the names stay
   * literals. The name is the version seam, as a job type is: a breaking payload change is a new
   * name, never an edited schema.
   */
  readonly events?: Readonly<Record<string, ZodTypeAny>>
}

// ---- Event names (D42) -------------------------------------------------------------------------

/** One segment after the plugin id: lower-case, digits, `-` and `_`, dot-separated. */
export const EVENT_NAME_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9_-]*)+$/

/**
 * `null` when `name` is an event `pluginId` may declare, else the sentence saying why not: it must
 * be `<pluginId>.<something>`, well formed, and never in the core `kit.` namespace. The same rule
 * `pnpm plugin check` applies to a manifest's `events` (`scripts/lib/plugin-lib.mjs`).
 */
export function eventNameProblem(pluginId: string, name: string): string | null {
  if (name.startsWith('kit.')) return `'${name}' is in the core kit. namespace`
  if (!name.startsWith(`${pluginId}.`)) return `'${name}' must start with '${pluginId}.'`
  if (!EVENT_NAME_RE.test(name)) {
    return `'${name}' must be lower-case dot-separated segments after '${pluginId}.'`
  }
  return null
}

// ---- Derivations the host's closed sets read ------------------------------------------------

/**
 * The value of an OPTIONAL `SharedPlugin` field across the whole barrel, skipping the plugins that
 * do not declare it.
 *
 * Why not `(typeof SHARED_PLUGINS)[number]['agentKeys']`: the barrel holds `as const satisfies
 * SharedPlugin` LITERALS, and a literal that omits an optional field genuinely has no such
 * property — so the indexed access is a compile error rather than `undefined`, and installing a
 * plugin with no agents would break the agent-key derivation for every other plugin. `Extract`
 * narrows the union to the members that DO declare the field first; with none, it is `never`, and
 * `never` is exactly the empty contribution every one of these derivations wants.
 */
export type DeclaredBy<P, K extends PropertyKey> =
  Extract<P, Record<K, unknown>> extends infer Declaring
    ? Declaring extends Record<K, unknown>
      ? Declaring[K]
      : never
    : never

/** The agent keys one plugin declares — what its `ServerPlugin.agents` must cover, exhaustively. */
export type AgentKeyOf<S extends SharedPlugin> = NonNullable<DeclaredBy<S, 'agentKeys'>>[number]

/** The prompt keys one plugin declares — what its `ServerPlugin.prompts` must cover. */
export type PromptKeyOf<S extends SharedPlugin> = NonNullable<DeclaredBy<S, 'promptKeys'>>[number]

/** The CASL subjects one plugin declares. */
export type SubjectOf<S extends SharedPlugin> = NonNullable<DeclaredBy<S, 'subjects'>>[number]

/**
 * The feature keys one plugin declares (the keys of its `features` record). Distributive, so a
 * UNION of plugins yields every plugin's keys — plain `keyof (A | B)` is only the keys they share.
 */
export type FeatureKeyOf<S extends SharedPlugin> = Extract<
  NonNullable<DeclaredBy<S, 'features'>> extends infer F
    ? F extends unknown
      ? keyof F
      : never
    : never,
  string
>

/**
 * The events one plugin declares — its `events` record. Distributive, so over a UNION of plugins it
 * is a union of records; `EventNameOf` / `EventPayloadOf` read names and payloads out of it.
 */
export type EventsOf<S extends SharedPlugin> = NonNullable<DeclaredBy<S, 'events'>>

/** The event names one plugin (or a union of plugins) declares. */
export type EventNameOf<S extends SharedPlugin> = Extract<
  EventsOf<S> extends infer R ? (R extends unknown ? keyof R : never) : never,
  string
>

/** The parsed payload of event `E`, from whichever plugin in `S` declares it. */
export type EventPayloadOf<S extends SharedPlugin, E extends string> =
  EventsOf<S> extends infer R
    ? R extends Record<E, infer Schema>
      ? Schema extends ZodTypeAny
        ? TypeOf<Schema>
        : never
      : never
    : never

/** The job types one plugin declares — what its `ServerPlugin.jobHandlers` must cover. */
export type JobTypeOf<S extends SharedPlugin> = TypeOf<
  NonNullable<DeclaredBy<S, 'jobs'>>[number]['shape']['type']
>
