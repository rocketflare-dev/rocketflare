/**
 * The shared half of a plugin (D31).
 *
 * A plugin is a separate git repository COPIED into an app — never installed from npm, exactly
 * like the kit itself — that contributes contracts, routes, schema, UI and CLI commands through
 * five barrels. `SharedPlugin` is the part all three consumers see: the zod contracts, the keys it
 * owns, and the `[vars]` it needs.
 *
 * **This module is a LEAF and must stay one.** It imports zod's types and nothing else. The
 * composers — `ai/agents.ts`, `jobs.ts`, `permissions.ts`, `features.ts`, `realtime.ts` — read the
 * plugin barrel to open their closed sets, so a plugin module that imported one of them back would
 * close a cycle through `plugins/index.ts` and leave one of the two sides holding `undefined` at
 * module-evaluation time. A plugin's own `index.ts` is under the same rule.
 *
 * Everything a plugin keys is namespaced with its `id` (tables `<id>_*`, job types `<id>.x`,
 * subjects, prompt/agent/feature keys, query-key roots `<id>:…`, the API prefix `/api/<id>`), so
 * two plugins installed in one app cannot collide and the host can always say which one owns a row.
 */
import type { ZodRawShape, ZodTypeAny } from 'zod'

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

export interface SharedPlugin {
  /** Matches `PLUGIN_ID_RE`; the namespace for everything below. */
  readonly id: string
  /** Human name, for the plugin list and the install plan. */
  readonly label: string
  /** The plugin's own semver, mirrored from its `rocketflare-plugin.json`. */
  readonly version?: string
  /**
   * Agent keys this plugin registers (`AGENT_KEYS = [...CORE, ...plugins]`, A2). Declared here
   * rather than server-side because the UI and the CLI validate agent input against the same enum.
   */
  readonly agentKeys?: readonly string[]
  /** Prompt registry keys this plugin owns (A2). */
  readonly promptKeys?: readonly string[]
  /**
   * Job envelope variants as DATA (A2): `jobInputSchema` becomes a discriminated union over
   * `[...CORE_JOB_VARIANTS, ...plugin variants]`. Typed loosely until A2 closes that set.
   */
  readonly jobs?: readonly ZodTypeAny[]
  /** CASL subjects this plugin adds (A2). */
  readonly subjects?: readonly string[]
  /** Feature-flag definitions keyed by flag key (A2 narrows the value type). */
  readonly features?: Readonly<Record<string, unknown>>
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
