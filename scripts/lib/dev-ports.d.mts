/**
 * Hand-written types for `dev-ports.mjs` (the workspace has no `allowJs`). Keep in step with the
 * exports there.
 */
export interface DevPorts {
  ui: number
  api: number
}
export interface DevPortsOptions {
  env?: Record<string, string | undefined>
  devVarsFile?: string
}
export const DEFAULT_UI_PORT: 3000
export const DEFAULT_API_PORT: 3001
export function resolveDevPorts(
  env?: Record<string, string | undefined>,
  devVars?: Record<string, string | undefined>
): DevPorts
export function resolveDevAllowedHosts(
  env?: Record<string, string | undefined>,
  devVars?: Record<string, string | undefined>
): string[]
export function readDevVarsFile(file?: string): Record<string, string>
export function devPorts(options?: DevPortsOptions): DevPorts
export function devAllowedHosts(options?: DevPortsOptions): string[]
