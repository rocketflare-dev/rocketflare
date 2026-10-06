/**
 * Hand-written types for `cloudflared.mjs` (the workspace has no `allowJs`). Keep in step with the
 * exports there.
 */
type Env = Record<string, string | undefined>

export type CloudflaredSource = 'override' | 'path' | 'managed'
export type CloudflaredPlan = { action: 'none'; source: CloudflaredSource } | { action: 'install' }

export const CLOUDFLARED_PINNED_VERSION: string
export function cloudflaredOverride(env: Env): string | null
export function managedBinaryPath(packageDir: string, platform?: NodeJS.Platform): string
export function cloudflaredVersion(env: Env): string
export function planCloudflared(opts: {
  env: Env
  onPath: () => boolean
  managedExists: () => boolean
}): CloudflaredPlan
export function cloudflaredOnPath(): boolean
export function resolveCloudflaredPackageDir(fromDir: string): string | null
export function runCloudflaredInstall(packageDir: string, version: string, env: Env): boolean

export interface EnsureCloudflaredOptions {
  env?: Env
  fromDir?: string
  onPath?: () => boolean
  resolvePackageDir?: (fromDir: string) => string | null
  exists?: (file: string) => boolean
  install?: (packageDir: string, version: string, env: Env) => boolean | Promise<boolean>
  log?: (msg: string) => void
}
export function ensureCloudflared(
  opts?: EnsureCloudflaredOptions
): Promise<{ installed: boolean; source: CloudflaredSource; bin?: string }>
