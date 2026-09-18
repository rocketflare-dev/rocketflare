/**
 * Hand-written types for the exports of `release-check.mjs` that something else drives (the
 * workspace has no `allowJs`), the same arrangement as `release.d.mts` beside it.
 *
 * `main` is deliberately absent: it is the CLI, guarded by `import.meta.url === process.argv[1]`,
 * and nothing should be importing it.
 */
import type { Deployability } from './lib/upgrade-lib.d.mts'

export const USAGE: string

/** One porting note on disk: its version, and its path relative to the repository root. */
export interface ReleaseNote {
  version: string
  file: string
}

export interface ResolvedRepoRoot {
  /** Absolute. */
  root: string
  /** `argv` with `--repo-root <path>` removed, for the caller's own option loop. */
  rest: string[]
  /** A usage message, or null. Only `--repo-root` with no path produces one. */
  error: string | null
}

/**
 * Which repository is being released or checked: `--repo-root`, else the git toplevel of `cwd`,
 * else the directory the script lives in. `toplevel` is injected so the decision is testable
 * without a filesystem — `apps/web/tests/config/release-root.test.ts` is what drives it.
 */
export function resolveRepoRoot(
  argv?: readonly string[],
  options?: {
    cwd?: string
    scriptRoot?: string
    toplevel?: (cwd: string) => string | null
  }
): ResolvedRepoRoot

export function releaseNotes(notesDir?: string, options?: { root?: string }): ReleaseNote[]

export function findPluginManifests(root?: string, options?: { maxDepth?: number }): string[]

export function deployable(root?: string): Deployability
