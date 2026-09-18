/**
 * The plugin API version comparison (D31) — one function, integers only.
 *
 * `requires.kit` is a semver RANGE and answers "which kit releases may I be installed into".
 * `requires.pluginApi` is an INTEGER and answers "which version of the plugin contract was I
 * written against" (`docs/plugin-api.md`). Keeping them apart is the point: the kit cut 0.5.0,
 * 0.6.0 and 0.6.1 without the plugin surface moving, and every plugin pinned by kit range had to
 * be re-released for each.
 *
 * **There is no range language here and there must never be one.** A malformed semver range throws
 * out of the matcher and arrives at the caller as a generic failure with nothing to act on —
 * which is the exact shape of bug this replaces. An integer has one way to be wrong, and one
 * sentence to say so.
 *
 * The numbers live in `packages/shared/src/plugins/contract.ts` (`PLUGIN_API`) and are mirrored
 * into `.rocketflare.json` `kit.pluginApi`, because this file runs under plain Node and cannot
 * import a `.ts` module. `apps/web/tests/config/plugin-api.test.ts` pins the two together.
 */

/**
 * The surface a copy of the kit provides, from its manifest.
 *
 * A manifest written before this existed has no `kit.pluginApi`, and version 1 is exactly what it
 * had: the surface that shipped with the field. Defaulting is therefore a statement of fact rather
 * than a guess, and it keeps `plugin add` working in a copy that has not taken this release yet.
 */
export function readPluginApi(manifest) {
  const declared = manifest?.kit?.pluginApi
  return {
    current: integerOr(declared?.current, 1),
    minSupported: integerOr(declared?.minSupported, 1),
  }
}

function integerOr(value, fallback) {
  const n = toInteger(value)
  return n === null ? fallback : n
}

/**
 * `"2"` and `2` both mean 2; everything else is null.
 *
 * A plugin's `plugin.json` is hand-written JSON, so the version arrives as a string about as often
 * as a number, and refusing one spelling would be a paper cut with no safety in it. `"2.0"`,
 * `">=2"` and `"two"` are all null — the caller turns that into the one sentence below.
 */
export function toInteger(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null
}

/**
 * What is wrong with a plugin's `requires.pluginApi`, as one sentence, or null.
 *
 * **Undeclared is null — warned elsewhere, never refused here.** A plugin released before this
 * existed cannot retroactively declare anything, and `analytics` 1.0.2 is the live case: the kit's
 * own second CI pass installs it. Declaring the version is what moves a plugin from "warned" to
 * "checked", and that happens in the release that migrates it. `pluginApiNote` is the line to
 * print for the undeclared case.
 *
 * @param declared `requires.pluginApi` from the plugin's own `plugin.json`
 * @param api `{ current, minSupported }` from `readPluginApi(manifest)`
 * @returns a sentence naming the fix, or null when the plugin may be installed
 */
export function pluginApiProblem(declared, api) {
  if (declared === undefined || declared === null || String(declared).trim() === '') return null
  const version = toInteger(declared)
  if (version === null) {
    return (
      `requires.pluginApi '${declared}' is not a whole number — the plugin API version is an ` +
      `integer, not a range (this kit provides ${api.current})`
    )
  }
  if (version > api.current) {
    return (
      `requires.pluginApi ${version} is newer than this kit's plugin API ${api.current} — ` +
      'upgrade the kit, or install an earlier release of the plugin'
    )
  }
  if (version < api.minSupported) {
    return (
      `requires.pluginApi ${version} is older than this kit supports (minimum ` +
      `${api.minSupported}, current ${api.current}) — the plugin needs migrating to the current ` +
      'contract (docs/plugin-api.md)'
    )
  }
  return null
}

/**
 * The line an install plan prints about the plugin API, and which mark to put in front of it.
 *
 * `'warn'` is reserved for the plugin that declares nothing: it is not an error — it installs —
 * but nothing is checked against it, so nobody finds out it was written against a surface that has
 * moved until something fails at runtime. Saying that at install time is the only chance to say it.
 */
export function pluginApiNote(declared, api) {
  const problem = pluginApiProblem(declared, api)
  if (problem) return { level: 'error', message: problem }
  if (declared === undefined || declared === null || String(declared).trim() === '') {
    return {
      level: 'warn',
      message:
        `plugin API ${api.current} — this plugin declares no requires.pluginApi, so nothing is ` +
        'checked against the contract it was written against',
    }
  }
  return {
    level: 'ok',
    message: `plugin API ${toInteger(declared)} is supported (this kit provides ${api.current})`,
  }
}
