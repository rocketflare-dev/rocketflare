/**
 * Hand-written types for `upgrade-lib.mjs` (the workspace has no `allowJs`). Keep in step with
 * the exports there; `apps/web/tests/config/upgrade-lib.test.ts` is what typechecks against this.
 */
import type { Names } from './rename-lib.d.mts'

export function globToRegExp(glob: string): RegExp
export function matchesAny(relPath: string, globs: readonly string[]): boolean

export type SurfaceKind = 'example' | 'optional-feature'
export interface Surface {
  id: string
  kind: SurfaceKind
  label: string
  /** Presence of this one file decides whether the surface is in the app at all. */
  anchor: string
  paths: string[]
  registries: string[]
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
  neverPort: string[]
  manual: string[]
  core: string[]
}

export function isKitManifest(manifest: Manifest | null): boolean
export function absentSurfaces(manifest: Manifest, presentPaths: readonly string[]): string[]

export type FileClass =
  | 'added'
  | 'added-collides'
  | 'modified'
  | 'deleted'
  | 'skipped-surface-absent'
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
export function compareVersions(a: string, b: string): -1 | 0 | 1
export const VERSION_RE: RegExp
