/** Hand-written types for `bootstrap-lib.mjs` (no `allowJs`); keep in step with the module. */

export function parseNvmrc(text: string): number
export function versionAtLeast(vString: string | undefined, major: number): boolean

export interface FillDevVarsResult {
  text: string
  /** Required keys that were empty or absent and are now generated. */
  filled: string[]
  /** Optional keys the example declares and the file lacks (warn, never fail). */
  missing: string[]
}
export function fillDevVars(
  exampleText: string,
  existingText: string | null,
  generate: () => string,
  requiredKeys: string[]
): FillDevVarsResult
export function readDevVars(text: string): Record<string, string>
export function describeTracing(values: Record<string, string>): string

export type AiBlockState = 'on' | 'off' | 'absent'
export function aiBlockState(tomlText: string): AiBlockState
export function toggleAiBlock(tomlText: string, mode: 'on' | 'off'): string

export function extractSeedKey(stdout: string): string | undefined

export interface WhoamiResult {
  loggedIn: boolean
  email?: string
  account?: string
}
export function parseWhoami(stdout: string | undefined): WhoamiResult

export const TEST_DB_PORT: number
export interface ChooseDevDbPortOptions {
  /** The port already in use by this checkout (from `.dev.vars`), kept when still available. */
  preferred?: number | null
  /** "Free, or already published by this checkout's own container." */
  isAvailable: (port: number) => boolean
  start?: number
  count?: number
  skip?: number[]
}
export function chooseDevDbPort(options: ChooseDevDbPortOptions): number | null
export function databaseUrlPort(url: string): number | null
export function withDatabaseUrlPort(url: string, port: number): string
export function upsertDevVar(text: string, key: string, value: string): string
export function checkoutTag(absolutePath: string): string

export interface DefaultPluginEntry {
  id: string
  repo: string
  ref?: string
  subdir?: string
}
export interface DefaultPluginPlan {
  install: { id: string; spec: string; args: string[] }[]
  skipped: string[]
  problems: string[]
}
export function planDefaultPlugins(
  entries: readonly unknown[] | undefined,
  installedIds?: readonly string[]
): DefaultPluginPlan

export class BootstrapUsageError extends Error {}
export function isPostgresUrl(value: string): boolean
export function isLocalDatabaseUrl(url: string): boolean
export const DATABASE_DRIVERS: readonly ['neon', 'postgres']
export function isNeonDatabaseUrl(url: string): boolean
export function localDriverFor(input?: {
  flag?: 'neon' | 'postgres' | null
  dbUrl?: string | null
  existing?: string
}): 'neon' | 'postgres'
export function databaseUrlTarget(url: string): string

export interface BootstrapOptions {
  yes: boolean
  shareDbIgnored: boolean
  offline: boolean
  online: boolean
  dev: boolean
  demo: boolean
  plugins: boolean
  open: boolean
  as: string
  /** `--db-url`: bootstrap against this database instead of the Docker one. */
  dbUrl: string | null
  /** `--driver` (D35): the local database driver, or null to keep / infer it. */
  driver: 'neon' | 'postgres' | null
  check: boolean
  verbose: boolean
  help: boolean
  /** Steps left out, in step order: `ROCKETFLARE_BOOTSTRAP_SKIP`, plus `install` for `--no-install`. */
  skip: BootstrapSkippableStep[]
  /** `ROCKETFLARE_ALLOW_ROOT=1`: run as uid 0 (a container whose commands all run as root). */
  allowRoot: boolean
}
export const BOOTSTRAP_SKIPPABLE_STEPS: readonly [
  'toolchain',
  'install',
  'secrets',
  'database',
  'migrate',
  'plugins',
  'seed',
  'cloudflare',
]
export type BootstrapSkippableStep = (typeof BOOTSTRAP_SKIPPABLE_STEPS)[number]
export function parseBootstrapSkip(value: string | undefined): BootstrapSkippableStep[]
export function parseBootstrapArgs(
  argv: readonly string[],
  env?: Record<string, string | undefined>
): BootstrapOptions

export interface BootstrapStepPlan {
  /** Step 1 checks `docker info` / `docker compose version`. */
  docker: boolean
  /** Step 4: start the compose database, or only poll `db:check` against an external one. */
  database: 'compose' | 'external'
  /** `host[:port]/db` of the external database (no credentials), else null. */
  target: string | null
  /** Extra environment for step 7's `pnpm seed`. */
  seedEnv: Record<string, string>
}
export function bootstrapStepPlan(input?: {
  dbUrl?: string | null
  check?: boolean
  devVarsDatabaseUrl?: string
}): BootstrapStepPlan
