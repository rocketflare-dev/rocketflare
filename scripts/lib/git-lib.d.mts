/**
 * Hand-written types for `git-lib.mjs` (the workspace has no `allowJs`). Keep in step with the
 * exports there.
 */
import type { Change } from './upgrade-lib.d.mts'

export interface GitResult {
  ok: boolean
  out: string
  err?: unknown
}
export interface Git {
  git(args: string[], opts?: Record<string, unknown>): string
  quiet(args: string[], opts?: Record<string, unknown>): GitResult
}
export function makeGit(cwd: string): Git
/** True when `repo` answers a quiet `git ls-remote` (no credential prompt). */
export function repoReachable(repo: string, cwd?: string): boolean
export function dirtyTree(cwd: string): string

export interface Mirror {
  dir: string
  run(args: string[]): string
  quiet(args: string[], opts?: Record<string, unknown>): GitResult
  resolves(ref: string): boolean
  commitOf(ref: string): string
  show(ref: string, file: string): string
  showRaw(ref: string, file: string): Buffer
  tryShow(ref: string, file: string): GitResult
  listFiles(ref: string, prefix?: string): string[]
  /** True when `ancestor` is reachable from `descendant` (so a diff between them runs backwards). */
  isAncestor(ancestor: string, descendant: string): boolean
  /** Fetch the blobs of `paths` at `ref` in one round trip (best effort). */
  prefetch(ref: string, paths: readonly string[]): void
  /** Every `X.Y.Z` release tag, newest first. */
  releaseTags(): string[]
  latestTag(): string | null
  /** Newest release of plugin `id`: its own `<id>-vX.Y.Z` tag or a lockstep `X.Y.Z` (#181). */
  latestTagFor(id: string | null, options?: { manifest?: string | null }): string | null
  /** A typed bare `X.Y.Z` as `<id>-vX.Y.Z` when that tag exists; any other ref unchanged. */
  releaseRef<T extends string | null | undefined>(id: string | null, ref: T): T
}
/** A release tag in either form: `X.Y.Z` (lockstep, id null) or `<id>-vX.Y.Z`; else null. */
export function parseReleaseTag(tag: string): { id: string | null; version: string } | null
export function pluginReleaseTag(id: string, version: string): string
/** The tags that can release `id`, newest first, its own tag first on a tie. */
export function releaseCandidates(tags: readonly string[], id?: string | null): string[]
export function mirror(dir: string): Mirror
export function ensureMirror(
  repo: string,
  dir: string,
  options?: {
    fetch?: boolean
    /** A failed fetch is fatal (exit 3) even with a cached mirror. */
    fresh?: boolean
    /** git's output off the terminal, and never a credentials prompt. */
    quiet?: boolean
    cwd?: string
    warn?: (line: string) => void
  }
): Mirror

/** Where a plugin repository's mirror lives, relative to the repository root. */
export const PLUGIN_MIRROR_ROOT: string
/** `<root>/<last segment of repo>.git`. One rule, so two scripts share one clone. */
export function mirrorDirFor(repo: string, root: string): string

export interface FileChange {
  path: string
  change: Change
}
export function collectChanges(
  m: Mirror,
  from: string,
  to: string,
  options?: { relative?: string | null }
): FileChange[]

export interface Rename {
  from: string
  to: string
  similarity: number
}
export function collectRenames(
  m: Mirror,
  from: string,
  to: string,
  options?: { relative?: string | null }
): Rename[]

export interface Note {
  version: string
  file: string
  text: string
}
export function notesBetween(
  m: Mirror,
  ref: string,
  options?: { after?: string | null; through?: string | null; dir?: string }
): Note[]

export interface Writer {
  root: string
  write(rel: string, text: string): string
  reset(): void
}
export function makeWriter(root: string): Writer
/** The newest lockstep tag, and each plugin whose own tag is at least as new, by id. */
export function newestReleases(
  tags: readonly string[],
  options?: { inLockstep?: (id: string) => boolean }
): {
  lockstep: string | null
  own: Map<string, string>
}
