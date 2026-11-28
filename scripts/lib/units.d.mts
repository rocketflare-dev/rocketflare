/**
 * Hand-written types for `units.mjs` (the workspace has no `allowJs`). Keep in step with the
 * exports there; `apps/web/tests/kit-only/units-lib.test.ts` typechecks against this.
 */

export type UnitKind = 'plugin' | 'domain'

export interface TableDefinition {
  name: string
  exportName: string | null
  file: string
  line: number
}

export interface UnitProblem {
  file: string
  line: number | null
  problem: string
  fix: string
}

export interface Unit {
  kind: UnitKind
  id: string
  trees: string[]
  files: string[]
  dependsOn: string[]
  tablePrefix: string
  tables: string[] | null
  definedTables: TableDefinition[]
  example: boolean
  problems: UnitProblem[]
}

export interface UnitFinding {
  severity: 'fail' | 'warn'
  unit: string
  kind: string
  file: string
  line: number | null
  problem: string
  fix: string
}

export interface DomainDefinitionRead {
  found: boolean
  dependsOn: string[]
  tablePrefix: string | null
  tables: string[] | null
  problems: Array<{ property: string; line: number; problem: string }>
}

export const RESERVED_UNIT_IDS: readonly string[]
export const UNIT_ID_RE: RegExp
export const APP_LISTS: Readonly<{ web: string; ui: string; schema: string; shared: string; cli: string }>
export const DOMAIN_ROOTS: readonly string[]
export const KIT_ROOT_NAMES: readonly string[]

export function sourceFilesUnder(repoRoot: string, dir: string): string[]
export function appDomainIds(repoRoot: string, listFile?: string): string[]
export function pluginIds(repoRoot: string): string[]
export function readDomainDefinition(source: string, file?: string): DomainDefinitionRead
export function tableDefinitions(repoRoot: string, files: readonly string[]): TableDefinition[]
export function unitTrees(kind: UnitKind, id: string): string[]
export function unitOfPath<U extends Pick<Unit, 'trees'>>(repoPath: string, units: readonly U[]): U | null
export function defaultTablePrefix(id: string): string
export function inNamespace(unit: Pick<Unit, 'tables' | 'tablePrefix'>, table: string): boolean
export function exampleIdsOf(manifest: unknown): Set<string>
export function readUnits(repoRoot: string, options?: { manifest?: unknown }): Unit[]
export function unitIdProblem(id: string, kind?: UnitKind): string | null
export function identityFindings(repoRoot: string, units: readonly Unit[]): UnitFinding[]
export function dependencyCycles(domains: ReadonlyArray<Pick<Unit, 'id' | 'dependsOn'>>): string[][]
export function tableFindings(units: readonly Unit[]): UnitFinding[]
export function isDomainPublicEntry(target: string, id: string): boolean
export function isPluginPublishedEntry(target: string, id: string): boolean
export function importFindings(
  repoRoot: string,
  units: readonly Unit[],
  options?: { coreFiles?: readonly string[] | null }
): UnitFinding[]
export function coreSourceFiles(repoRoot: string, units: readonly Unit[]): string[]
export function unitFindings(
  repoRoot: string,
  options?: { manifest?: unknown; units?: readonly Unit[] | null }
): UnitFinding[]
export function incomingPluginFindings(
  repoRoot: string,
  manifest: unknown,
  options?: { kitManifest?: unknown }
): UnitFinding[]
