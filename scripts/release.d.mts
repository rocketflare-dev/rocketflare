/**
 * Hand-written types for the exports of `release.mjs` that something else drives (the workspace has
 * no `allowJs`). Keep in step with the script; `apps/web/tests/config/release-lib.test.ts` is what
 * typechecks against this.
 *
 * Only the two testable seams are declared. `main` is deliberately absent: it is the CLI, guarded
 * by `import.meta.url === process.argv[1]`, and nothing should be importing it.
 */
import type { Mirror } from './lib/git-lib.d.mts'
import type {
  DefaultPluginEntry,
  Manifest,
  ResolvedDefaultPlugin,
} from './lib/upgrade-lib.d.mts'

export const USAGE: string

/** Which kind of repository a release is being cut in — see `releaseContext`. */
export type ReleaseKind = 'kit' | 'app' | 'plugin' | 'unknown'
export interface ReleaseVersionFile {
  file: string
  pattern: RegExp
  label: string
}
export interface ReleaseContext {
  kind: ReleaseKind
  notesDir?: string
  changelog?: string
  versionFiles?: ReleaseVersionFile[]
}
export function releaseContext(root?: string): ReleaseContext

/**
 * What `resolveDefaultPlugin` asks of a mirror. A test injects a stub with just these three, which
 * is why the parameter is narrowed rather than typed as the whole `Mirror`.
 */
export type MirrorReader = Pick<Mirror, 'resolves' | 'latestTag' | 'tryShow'>

export function resolveDefaultPlugin(
  entry: DefaultPluginEntry,
  options?: {
    manifest?: Manifest | null
    /** Injected in tests; by default a blobless bare mirror under `.upgrade/plugins/`. */
    openMirror?: (repo: string) => MirrorReader
    /** Injected in tests; by default `git ls-remote --exit-code`. */
    lsRemote?: (repo: string, ref: string) => boolean
  }
): ResolvedDefaultPlugin
