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
 * without a filesystem — `apps/web/tests/kit-only/release-root.test.ts` is what drives it.
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

/** The five facts `versionOnlyProblems` decides on — see `versionOnly` for how each is read. */
export interface VersionOnlyFacts {
  /** HEAD's parent shas. */
  parents: string[]
  /** The named parent, resolved to a sha; null when it does not resolve. */
  parentSha: string | null
  /** `git diff --name-only --no-renames <parent> HEAD`. */
  changed: string[]
  /** The parent's root `package.json` text; null when it has none. */
  before: string | null
  /** HEAD's root `package.json` text; null when it has none. */
  after: string | null
}

/** Why HEAD is NOT only a root-`package.json` `"version"` bump over its one parent; empty = it is. */
export function versionOnlyProblems(facts: VersionOnlyFacts): string[]

export interface VersionOnly {
  /** The parent's sha, or null when it did not resolve. */
  parent: string | null
  problems: string[]
}

/** `versionOnlyProblems` over the committed HEAD of the checkout at `root`. `git` is injected. */
export function versionOnly(
  root: string,
  parent: string,
  options?: { git?: (root: string, args: string[]) => string | null }
): VersionOnly

/** Successful push / pull_request `ci.yml` runs on exactly `sha`, via `gh api`; null on any doubt. */
export function successfulCiRuns(
  repo: string,
  sha: string,
  options?: { exec?: (cmd: string, args: string[], opts: object) => string }
): number | null

/** deploy.yml `gated`: `sha`'s own green CI run, or a version-only bump over a green parent. */
export function gatedDecision(input: {
  sha: string
  runs: (sha: string) => number | null
  versionOnly: () => VersionOnly
}): { gated: boolean; reason: string }
