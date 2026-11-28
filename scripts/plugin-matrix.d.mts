/**
 * Hand-written types for `plugin-matrix.mjs` (the workspace has no `allowJs`). Keep in step with
 * the script; `apps/web/tests/kit-only/plugin-matrix.test.ts` typechecks against this.
 */
export const PLUGINS_REPO: string
export const FULL_HOUSE: 'full-house'
export const MANIFEST: string
export const STEP_NAMES: Readonly<Record<'deps' | 'db' | 'install' | 'migrate' | 'check' | 'rehearse' | 'gate', string>>

export interface PublishedPlugin {
  id: string
  version: string | null
  subdir: string
  requires: string[]
  /** The release tag it is installed from (#181): its own `<id>-vX.Y.Z` or the lockstep `X.Y.Z`. */
  ref?: string
}
export interface MatrixEntry {
  id: string
  version: string | null
  /** `id=subdir` pairs, space separated, in install order. */
  installs: string
  /** `id=ref` pairs for the plugins with a ref of their own; the rest install at `plugins_ref`. */
  refs: string
}
export interface MatrixResult {
  id: string
  version: string | null
  kitRef: string | null
  kitSha: string | null
  runUrl: string | null
  outcome: 'success' | 'failure' | 'unknown'
  step: string | null
  tests: string[]
  warnings: number | null
}
export type StepsContext = Record<string, { outcome?: string; conclusion?: string } | undefined>

export function installOrder(plugins: readonly PublishedPlugin[], ids: readonly string[]): PublishedPlugin[]
export function matrixEntries(
  plugins: readonly PublishedPlugin[],
  options?: { only?: readonly string[]; fullHouse?: boolean }
): MatrixEntry[]
export function pluginsFromTree(
  files: readonly string[],
  read: (file: string) => string
): PublishedPlugin[]
export function readPlugins(root: string): PublishedPlugin[]
export function parseReleaseTag(tag: string): { id: string | null; version: string } | null
export function lsRemoteTags(lsRemote: string): string[]
export function newestReleases(
  tags: readonly string[],
  options?: { inLockstep?: (id: string) => boolean }
): {
  lockstep: string | null
  own: Map<string, string>
}
export function newestTag(lsRemote: string): string | null
export function latestPlugins(
  tags: readonly string[],
  readAt: (tag: string) => PublishedPlugin[]
): { lockstep: string | null; plugins: PublishedPlugin[] }
export function parseFailures(log: string): { gateSteps: string[]; tests: string[] }
export function countWarnings(checkJson: string | null, id: string): number | null
export function failingStep(steps: StepsContext | null | undefined, gateSteps?: readonly string[]): string | null
export function buildResult(input: {
  id: string
  version: string | null
  kitRef: string | null
  kitSha: string | null
  runUrl: string | null
  steps: StepsContext
  log?: string
  checkJson?: string | null
}): MatrixResult
export function missingResults(
  expected: ReadonlyArray<{ id: string; version?: string | null }>,
  results: readonly MatrixResult[]
): MatrixResult[]
export function summaryTable(results: readonly MatrixResult[]): string
export interface JobVerdict {
  plugin: string
  ok: boolean
  conclusion: string
  step: string | null
  url: string | null
}
export function jobVerdicts(
  jobs: ReadonlyArray<{
    name?: string
    conclusion?: string | null
    status?: string
    url?: string
    steps?: ReadonlyArray<{ name?: string; conclusion?: string | null }>
  }> | null | undefined
): JobVerdict[]
export function main(argv: string[]): number
