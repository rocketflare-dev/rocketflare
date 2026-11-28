/**
 * Hand-written types for the exports of `release.mjs` that something else drives (the workspace has
 * no `allowJs`). Keep in step with the script; `apps/web/tests/kit-only/release-lib.test.ts` is what
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
  /** The plugin's declared id — `kind: 'plugin'` only, and null when the manifest omits one. */
  id?: string | null
  /** Repo-root-relative, always: a monorepo resolves a context inside a subdirectory. */
  notesDir?: string
  changelog?: string
  versionFiles?: ReleaseVersionFile[]
}
export function releaseContext(
  root?: string,
  /**
   * `repoRoot` is what every path in the returned context is relative to. It defaults to `root`,
   * which is the kit and a single-plugin repository; a plugin MONOREPO passes the repository root
   * while `root` is `plugins/<id>` (D31).
   */
  options?: { repoRoot?: string }
): ReleaseContext

/**
 * What `resolveDefaultPlugin` asks of a mirror. A test injects a stub with just these three, which
 * is why the parameter is narrowed rather than typed as the whole `Mirror`.
 */
export type MirrorReader = Pick<Mirror, 'resolves' | 'releaseRef' | 'latestTagFor' | 'tryShow'>

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

/** The paths where a change deserves a security audit before a kit release. */
export const AUDIT_CADENCE_GLOBS: readonly string[]
/** The changed paths `AUDIT_CADENCE_GLOBS` (or `globs`) match, in input order. */
export function auditCadencePaths(changed: readonly string[] | null | undefined, globs?: readonly string[]): string[]
/** The warning lines `pnpm kit:release` prints for those paths; [] when there are none. */
export function auditCadenceWarning(paths: readonly string[], previous: string): string[]

/** One list item of a note section: its first line (marker dropped) and its continuation lines. */
export interface NoteItem {
  first: string
  rest: string[]
}
/** A section's list items; a step's own number, if it has one, is ignored. */
export function listItems(content: string | null | undefined): NoteItem[]
/** One pending part of a release: a fragment, or the legacy `unreleased.md` (`legacy: true`). */
export interface NotePart {
  /** The filename: fragments are folded in filename order after their `order`. */
  name: string
  text: string
  legacy?: boolean
}
/**
 * Fold the pending parts into one porting note: frontmatter unioned and ORed, sections
 * concatenated (`order` first, then the legacy file, then fragments by filename), How to apply and
 * Verify renumbered, a single trailing "`pnpm gate` passes.".
 */
export function mergeNotes(
  parts: readonly NotePart[],
  release: { version: string; previous: string | null; date: string }
): string

/** The plugin matrix (#180): the workflow file `kit:release` dispatches, and its default wait. */
export const MATRIX_WORKFLOW: string
export const MATRIX_WAIT_MINUTES: number
export interface ToolResult {
  status: number
  stdout: string
  stderr: string
}
export type ToolRunner = (cmd: string, args: string[], options?: { cwd?: string }) => ToolResult
/** `spawnSync` as a result object; a missing binary is status -1, never a throw. */
export function runTool(cmd: string, args: string[], options?: { cwd?: string }): ToolResult
export type MatrixHandle =
  | { skipped: string; requestId?: undefined }
  | { requestId: string; sha: string; unpushed: boolean; skipped?: undefined }
/** Dispatch the matrix against origin/main; `{ skipped }` with the reason when it cannot. */
export function dispatchPluginMatrix(options: {
  version: string
  root: string
  run?: ToolRunner
  now?: () => number
}): MatrixHandle
/** Wait for the dispatched run (bounded) and return the lines to print. */
export function awaitPluginMatrix(
  handle: MatrixHandle,
  options?: {
    root?: string
    run?: ToolRunner
    sleep?: (ms: number) => void
    now?: () => number
    timeoutMs?: number
    pollMs?: number
  }
): string[]
/** `✔` for an all-green run, else one `⚠ <plugin> fails on main: <step>, <url>` per red job. */
export function pluginMatrixLines(
  verdicts: ReadonlyArray<{ plugin: string; ok: boolean; conclusion: string; step: string | null; url: string | null }>,
  url: string
): string[]
