/**
 * Hand-written types for `plugin-lib.mjs` (the workspace has no `allowJs`). Keep in step with the
 * exports there; `apps/web/tests/config/plugin-lib.test.ts` is what typechecks against this.
 */
import type { Surface } from './upgrade-lib.d.mts'

export const PLUGIN_ID_RE: RegExp
export const RESERVED_PLUGIN_IDS: readonly string[]
export function pluginIdProblem(id: unknown): string | null
export function camelId(id: string): string

export type BarrelKind = 'shared' | 'server' | 'ui' | 'schema' | 'cli'
export interface BarrelDefinition {
  file: string
  /** `null` for the schema barrel, which is `export *` rather than a tuple. */
  constName: string | null
  suffix: string | null
  specifier(id: string): string
  /** The file whose presence means the plugin ships this half. */
  half(id: string): string
}
export const BARRELS: Readonly<Record<BarrelKind, BarrelDefinition>>
export const BARREL_KINDS: readonly BarrelKind[]
export function barrelExportName(kind: BarrelKind, id: string): string | null
export function barrelLines(kind: BarrelKind, id: string): string[]
export function hasBarrelLine(text: string, kind: BarrelKind, id: string): boolean
export function tupleEntries(text: string, constName: string): string[]
export function addBarrelLine(text: string, kind: BarrelKind, id: string): string
export function removeBarrelLine(text: string, kind: BarrelKind, id: string): string

export type FileRole = 'copy' | 'note' | 'fragment' | 'meta' | 'repo-only' | 'refused'
export const FILE_ROLES: readonly FileRole[]
export function pluginRoots(id: string): string[]
export const PLUGIN_MANIFEST_FILE: string
export interface FileClassification {
  role: FileRole
  reason?: string
  target?: string
  root?: string
}
export function classifyPluginFile(relPath: string, id: string): FileClassification

/**
 * The binding types provisioning can create. Pinned against
 * `apps/web/scripts/provision/plugin-resources.ts`'s `SUPPORTED_PLUGIN_BINDING_TYPES` by
 * `plugin-lib.test.ts` — one is TypeScript, one has to be loadable from a plain `.mjs` script.
 */
export const SUPPORTED_PLUGIN_BINDING_TYPES: readonly ['kv', 'queue', 'r2']
export function pluginPlatformProblems(manifest: PluginManifest): string[]

export interface PluginRequires {
  kit?: string
  surfaces?: string[]
  plugins?: string[]
}
export interface PluginManifest {
  id: string
  label?: string
  version?: string
  repo?: string
  subdir?: string
  anchor?: string
  paths?: string[]
  registries?: string[]
  requires?: PluginRequires
  dependencies?: Record<string, Record<string, string>>
  bindings?: Array<{ type: string; binding?: string; name?: string; consumer?: boolean }>
  crons?: Array<string | { cron: string; task?: string }>
  apiPrefixes?: string[]
  vars?: Array<string | { key?: string; name?: string; example?: string; secret?: boolean }>
  workerExports?: string[]
  schema?: { tables?: string[]; rlsExcluded?: string[] }
  migrations?: string[]
}

/** The installed plugins a move to kit `version` would leave unsupported (vendored ones exempt). */
export function unsupportedForKit(
  plugins: Array<{
    id: string
    source?: { repo?: string; subdir?: string } | null
    requires?: { kit?: string } | null
  }>,
  at: { kitRepo?: string | null; version?: string | null }
): Array<{ id: string; requires: { kit: string } }>

export function checkRequirements(input: {
  requires?: PluginRequires
  kitVersion: string
  presentSurfaces?: readonly string[]
  installedPlugins?: ReadonlyArray<{ id: string; version?: string | null }>
  vendored?: boolean
}): string[]
export function parsePluginRequirement(entry: string | { id: string; range?: string }): {
  id: string
  range: string | null
}
export function isVendored(
  source: { repo?: string; subdir?: string } | null | undefined,
  kitRepo: string
): boolean

export function buildPluginSurface(
  manifest: PluginManifest,
  source: { repo: string; subdir?: string; commit?: string | null; at: string }
): Surface
export function surfaceDirectories(surface: Surface): string[]
export function archiveSql(id: string, tables: readonly string[]): string

export interface AddPlan {
  manifest: PluginManifest
  source: { repo: string; subdir?: string; ref?: string | null; commit?: string | null }
  host: { label: string; kitVersion: string; recordsIn: string; translated: boolean }
  vendored: boolean
  problems: string[]
  files: Array<{ path: string } & FileClassification>
  byRoot: Record<string, number>
  barrels: BarrelKind[]
  verify?: string | null
}
export function renderAddPlan(plan: AddPlan): string[]
export function renderList(
  surfaces: readonly Surface[],
  options?: { sidecarIds?: readonly string[] }
): string[]
