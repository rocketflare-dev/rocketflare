/**
 * Hand-written types for `upgrade-lib.mjs` (the workspace has no `allowJs`). Keep in step with
 * the exports there; `apps/web/tests/config/upgrade-lib.test.ts` is what typechecks against this.
 */
import type { Names } from './rename-lib.d.mts'

export function globToRegExp(glob: string): RegExp
export function matchesAny(relPath: string, globs: readonly string[]): boolean

export type SurfaceKind = 'example' | 'optional-feature' | 'plugin'
export interface PluginSource {
  /** Canonical git URL — never null for a `kind: 'plugin'` surface. */
  repo: string
  subdir?: string
  version?: string
  commit?: string | null
}
export interface Surface {
  id: string
  kind: SurfaceKind
  label: string
  /** Presence of this one file decides whether the surface is in the app at all. */
  anchor: string
  paths: string[]
  registries: string[]
  /** `kind: 'plugin'` only (D31): where the plugin came from. */
  source?: PluginSource
  installedAt?: string
  /**
   * The oldest kit release this plugin supports — one version, no ceiling (D31). `null` when the
   * plugin declared none, which means no kit version is ever checked against it.
   */
  minKit?: string | null
  requires?: {
    surfaces?: string[]
    plugins?: Array<string | { id: string; minVersion?: string | null }>
  }
  history?: HistoryEntry[]
}
export interface KitBlock {
  name: string
  repo: string
  version: string
  commit: string | null
}
export interface AppBlock {
  slug: string
  display: string
  domain: string
}
export interface HistoryEntry {
  from: string
  to: string
  at: string
}
export interface Manifest {
  /** Prose for whoever finds this file and wonders what it is. */
  $purpose: string
  /** Prose saying what deleting it costs, and how to recover. */
  $doNotDelete: string
  kit: KitBlock
  /** `null` in the kit itself; the derived names in an adopted copy. */
  app: AppBlock | null
  history: HistoryEntry[]
  surfaces: Surface[]
  /** Plugins a fresh clone installs, and the kit's own CI gates on (D31, decisions 2 and 5). */
  defaultPlugins?: (string | Partial<DefaultPluginEntry>)[]
  /**
   * Surface id → the release that retired it. Released notes still name these, and released
   * history is never rewritten, so both readers of a note accept them (§13).
   */
  retiredSurfaces?: Record<string, string>
  neverPort: string[]
  manual: string[]
  core: string[]
}

export function isKitManifest(manifest: Manifest | null): boolean
export function absentSurfaces(manifest: Manifest, presentPaths: readonly string[]): string[]

export interface Deployability {
  deployable: boolean
  reason: string
}
/** `tomls` is `{ path: text }`. See the implementation for why the default is "deploy". */
export function isDeployable(
  manifest: Manifest | null,
  tomls: Record<string, string>
): Deployability
export const PLACEHOLDER_RE: RegExp

export type FileClass =
  | 'added'
  | 'added-collides'
  | 'modified'
  | 'deleted'
  | 'skipped-surface-absent'
  | 'skipped-plugin-owned'
  | 'skipped-locally-deleted'
  | 'skipped-kit-only'
  | 'migration-derived'
  | 'manual-toml'
  | 'manual-env'
  | 'manual'
  | 'binary'
  | 'verbatim'
export const CLASSES: readonly FileClass[]

export type Change = 'added' | 'modified' | 'deleted' | 'binary'
export interface ClassifyContext {
  manifest: Manifest
  /** Surface ids whose anchor file is missing locally. */
  absent?: readonly string[]
  existsLocally?: boolean
  change?: Change
  includeKitTooling?: boolean
}
export interface Classification {
  class: FileClass
  /** Whether the file BODY goes through the rename token map. Paths always do. */
  translate: boolean
  reason: string
  surface?: string
}
export function classifyPath(relPath: string, ctx: ClassifyContext): Classification

export interface DiffBlock {
  header: string
  raw: string
}
export function splitDiff(patchText: string): DiffBlock[]
export class BinaryPatchError extends Error {}
export function translateBlock(
  block: DiffBlock,
  names: Names,
  options?: { translate?: boolean }
): string
export function countLines(text: string): number
export function stripIndexLines(text: string): string
export interface TranslateResult {
  patch: string
  kept: number
  skipped: Array<{ header: string } & Partial<Classification> & { path?: string }>
}
export function translatePatch(
  patchText: string,
  names: Names,
  decide: (header: string) => (Classification & { path?: string }) | undefined
): TranslateResult
export const APPLYABLE: ReadonlySet<FileClass>

export interface NoteFrontmatter {
  version: string
  previous: string | null
  date: string
  breaking: boolean
  migrations: string[]
  areas: string[]
  touches_surfaces: string[]
  requires_surfaces: string[]
  manual: boolean
}
export interface ParsedNote {
  data: Record<string, unknown> & Partial<NoteFrontmatter>
  body: string
}
export function parseNote(text: string): ParsedNote | null
export const NOTE_HEADINGS: readonly string[]

/** What `noteProblems` needs from its caller; see the implementation for why each is optional. */
export interface NoteCheckOptions {
  /** How the note is named in every sentence — a path, usually. */
  file?: string
  /** The filename's version stem; `null` for `unreleased.md` (no version, no date to check). */
  version?: string | null
  /** Checked only when given; the baseline note expects the string `'null'`. */
  expectPrevious?: string
  /** `null` skips the surface check rather than reporting every id as unknown. */
  surfaceIds?: readonly string[] | null
  /** `.rocketflare.json`'s `retiredSurfaces`: removed on purpose, still named by older notes. */
  retiredSurfaceIds?: Record<string, string>
  manifestFile?: string
}

/**
 * Everything wrong with one porting note, as sentences — the ONE statement of the note schema,
 * read by `release-check.mjs` and by `upgrade-notes.test.ts`.
 */
export function noteProblems(text: string, options?: NoteCheckOptions): string[]
export function compareVersions(a: string, b: string): -1 | 0 | 1
export const VERSION_RE: RegExp

/** Anchored `## <version>` — `includes('## 0.6.1')` also matches `## 0.6.10`. */
export function hasChangelogSection(text: string, version: string): boolean

/** One porting note's line in a `CHANGELOG.md` section. */
export interface ChangelogEntry {
  /** The plugin's id — rendered only when a release covers more than one (D31). */
  id?: string | null
  summary: string
  /** Repo-root-relative path of the note, as the link target. */
  note: string
}
export function changelogSection(
  version: string,
  date: string,
  entries: readonly ChangelogEntry[]
): string
export function prependChangelogSection(text: string, section: string): string

/** What needs a porting note: `apps/` or `packages/` source, tests and markdown excluded. */
export const BEHAVIOUR_PATH_RE: RegExp
export const BEHAVIOUR_EXEMPT_RE: RegExp
export function behaviourFiles(
  changed: readonly string[] | undefined,
  /** `within` scopes the predicate to a subdirectory — the plugin monorepo (D31). */
  options?: { within?: string }
): string[]

/**
 * True when a plugin ships inside the kit itself (`source.repo` is the kit's, no subdirectory).
 * The ONE implementation; `plugin-lib.mjs` re-exports it.
 */
export function isVendored(
  source: { repo?: string | null; subdir?: string | null } | null | undefined,
  kitRepo: string | null | undefined
): boolean

/** One `defaultPlugins` entry, normalised (D31, decision 5). */
export interface DefaultPluginEntry {
  id: string | null
  repo: string | null
  ref: string | null
  subdir: string
}
export function defaultPluginEntries(manifest: Manifest | null): DefaultPluginEntry[]

/** The shape check over a normalised list — no I/O. Shared with the bootstrap and both workflows. */
export function defaultPluginEntryProblems(
  entries: readonly DefaultPluginEntry[] | undefined
): string[]

/** What an injected resolver answers about one default plugin. */
export interface ResolvedDefaultPlugin {
  ok: boolean
  reason?: string
  /** The plugin's declared floor — one bare `X.Y.Z`, read from the TOP level only. */
  minKit?: string | null
  /**
   * A `requires.kit` range the source still declares, carried out so the caller can name the
   * field and its replacement. Never used as a floor: there is no range machinery left to read it.
   */
  legacyRange?: string | null
  version?: string | null
}

/**
 * Why `version` must not be released — one sentence per problem. Pure; `resolve` does the I/O.
 * A vendored entry (`kitRepo`, no subdir) is exempt from the floor check.
 */
export function defaultPluginProblems(
  entries: readonly DefaultPluginEntry[],
  version: string,
  resolve: (entry: DefaultPluginEntry) => ResolvedDefaultPlugin | null,
  options?: { kitRepo?: string | null }
): string[]
