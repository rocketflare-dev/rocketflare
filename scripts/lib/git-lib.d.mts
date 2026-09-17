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
  latestTag(): string | null
}
export function mirror(dir: string): Mirror
export function ensureMirror(
  repo: string,
  dir: string,
  options?: { fetch?: boolean; cwd?: string; warn?: (line: string) => void }
): Mirror

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
