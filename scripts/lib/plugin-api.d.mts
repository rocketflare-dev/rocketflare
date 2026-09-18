/**
 * Hand-written types for `plugin-api.mjs` (the workspace has no `allowJs`). Keep in step with the
 * exports there; `apps/web/tests/config/plugin-api.test.ts` is what typechecks against this.
 */

export interface PluginApiVersions {
  current: number
  minSupported: number
}

export function readPluginApi(manifest: unknown): PluginApiVersions
export function toInteger(value: unknown): number | null
export function pluginApiProblem(declared: unknown, api: PluginApiVersions): string | null

export interface PluginApiNote {
  level: 'ok' | 'warn' | 'error'
  message: string
}
export function pluginApiNote(declared: unknown, api: PluginApiVersions): PluginApiNote
