/**
 * Hand-written types for `dev-ai.mjs` (the workspace has no `allowJs`). Keep in step with the
 * exports there.
 */
export const DEV_WORKERS_AI: 'DEV_WORKERS_AI'
export const OFFLINE_CONFIG: '.wrangler.offline.toml'
export type DevWorkersAiMode = 'on' | 'off'
export function devWorkersAiMode(
  env?: Record<string, string | undefined>,
  devVars?: Record<string, string | undefined>
): DevWorkersAiMode
export function offlineConfigText(tomlText: string): string
export interface WranglerDevConfig {
  mode: DevWorkersAiMode
  args: string[]
  note: string | null
}
export function wranglerDevConfigArgs(options: {
  webDir: string
  env?: Record<string, string | undefined>
  devVars?: Record<string, string | undefined>
}): WranglerDevConfig
