/**
 * The plugin API version (D31) — which SURFACE a plugin compiles against, as two integers.
 *
 * **This is not `requires.kit`, and the two must never be merged.** `requires.kit` answers *which
 * kit releases may I be installed into* — a product question, spanning every behaviour the kit
 * ships. This answers *which version of the plugin contract was I written against* — the context
 * family, the schema kit, the shared and CLI entries, the test kit. They move at different rates
 * and for different reasons: the kit cut 0.5.0, 0.6.0 and 0.6.1 without the plugin surface moving
 * at all, and a plugin pinned by kit range had to be re-released for each. Conflating them is what
 * made every plugin's pin a guess, and the guess is what drifted.
 *
 * - `current` — the surface this kit provides. Bumped by the ONE commit that changes or removes a
 *   declared member; `scripts/plugin-api-doc.mjs` refuses to regenerate `docs/plugin-api.md`
 *   without it, and names the member.
 * - `minSupported` — the oldest surface this kit still honours. Raise it only when a removal has
 *   actually landed, and say so in the release note: every plugin below it stops installing.
 *
 * **The comparison is integer, and there is no range language anywhere near it.** That is the
 * whole point. `requires.kit` is a semver range, so a malformed one throws out of the matcher and
 * arrives as a generic failure with nothing to act on — which is exactly the shape of bug this
 * replaces. An integer has one way to be wrong and one sentence to say so;
 * `scripts/lib/plugin-api.mjs` is the single comparison, and `pluginApiProblem` is what
 * `plugin add | check | upgrade` calls.
 *
 * **Undeclared is warned, never failed.** A plugin released before this existed declares no
 * `requires.pluginApi`, and refusing it would break installs of plugins nobody can retroactively
 * change — `analytics` 1.0.2, which the kit's own second CI pass installs, is the live case.
 * Declaring the version is what moves a plugin from "warned" to "checked", and it happens in the
 * release that migrates it.
 *
 * **Zero imports, deliberately.** Everything under `packages/shared/src/plugins/**` is forbidden
 * from importing one of the five composers at runtime (`ai/agents.ts`, `jobs.ts`,
 * `permissions.ts`, `features.ts`, `realtime.ts`), because those read the plugin barrel and two
 * zod modules in a cycle crash at module evaluation rather than failing to compile. A leaf with no
 * imports at all cannot participate in any cycle, which is what lets the tooling, the tests and a
 * plugin's own contract all read this without anybody checking what it drags in.
 *
 * **It exists twice, and the duplication is pinned.** `.rocketflare.json` carries
 * `kit.pluginApi`, because `scripts/*.mjs` runs under plain Node and cannot import a `.ts` module —
 * the same trade `SUPPORTED_PLUGIN_BINDING_TYPES` already lives with.
 * `apps/web/tests/config/plugin-api.test.ts` asserts the two are identical, so moving one without
 * the other fails the suite rather than leaving the tooling and the surface disagreeing in silence.
 */

/** The plugin API version this kit provides, and the oldest one it still honours. */
export const PLUGIN_API = {
  current: 1,
  minSupported: 1,
} as const

/** `{ current, minSupported }` — what `pluginApiProblem` compares a plugin's declaration against. */
export interface PluginApiVersions {
  /** The surface this kit provides. A plugin declaring a higher number needs a newer kit. */
  current: number
  /** The oldest surface still honoured. A plugin declaring a lower number needs migrating. */
  minSupported: number
}
