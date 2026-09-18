/**
 * Hand-written types for `surface.mjs` (the workspace has no `allowJs`). Keep in step with the
 * exports there; `apps/web/tests/config/surface.test.ts` is what typechecks against this.
 */

/** One entry of the ledger: the specifier a plugin writes, and the module it resolves to. */
export interface LedgerEntry {
  /** The ledger's KEY — the specifier as a plugin spells it. */
  import: string
  /** Repo-relative path of the module that entry IS. */
  file: string
}
export const LEDGER_ENTRIES: readonly LedgerEntry[]

export const PLUGIN_ROOTS: readonly string[]
export const DECLARED_ENTRIES: readonly string[]
export const RESERVED_PLUGIN_IDS: ReadonlySet<string>
export const SUGGESTED_ENTRY: ReadonlyArray<readonly [string, string]>

export function normaliseModulePath(p: string): string
export function pluginIdOfPath(repoPath: string): string | null
export function resolveSpecifier(importer: string, specifier: string): string | null
export function ledgerEntryOfModule(modulePath: string | null | undefined): string | null
/** The DECLARED entry a resolved module falls under, or null. Exact, or a directory prefix. */
export function declaredEntryOf(modulePath: string | null | undefined): string | null
/**
 * A repo path back to the specifier a plugin writes — the inverse of `resolveSpecifier`, and the
 * key `usesOf` records an unledgered declared entry under.
 */
export function canonicalSpecifier(modulePath: string | null | undefined): string | null
export function suggestionFor(target: string): string

/** One static import or re-export, with the names it binds. */
export interface ModuleImport {
  specifier: string
  /** The EXPORTED names (`import { a as b }` is `a`). Empty for a namespace or default import. */
  names: string[]
  /** `import * as x` — binds no attributable name, so `names` is empty and this says why. */
  namespace: boolean
  typeOnly: boolean
  /** 1-based, so a diagnostic can name the line to edit rather than only the file. */
  line: number
}
export function moduleImports(source: string, fileName?: string): ModuleImport[]

export interface StaticImport {
  specifier: string
  typeOnly: boolean
  line: number
}
export function staticImports(source: string): StaticImport[]

/** One member the kit provides, as the ledger recorded it. */
export interface LedgerMember {
  entry: string
  kind: string
  /** `foo`, or `Type.member` for an expanded interface member. */
  name: string
  signature: string
}

/** The kit's surface, with membership keyed `"<entry> :: <name>"`. */
export interface Ledger {
  members: ReadonlyMap<string, LedgerMember>
  size: number
  has(entry: string, name: string): boolean
  get(entry: string, name: string): LedgerMember | undefined
}

/** Null when the file, the section or the fenced block is absent — never a throw. */
export function readLedger(repoRoot: string): Ledger | null

/**
 * `{ [entry]: [sorted unique symbol names] }`, derived from the plugin's own imports.
 *
 * Every DECLARED entry is recorded, ledgered or not — which entries the ledger may judge is
 * `missingFrom`'s policy, deliberately not this measurement's.
 */
export type PluginUses = Record<string, string[]>
export function usesOf(repoRoot: string, pluginId: string): PluginUses

/** One symbol a plugin names that the kit no longer provides. */
export interface MissingSymbol {
  entry: string
  symbol: string
  /** The replacement import when the symbol moved entry; null when it exists nowhere. */
  suggestion: string | null
}
export function missingFrom(
  uses: PluginUses | null | undefined,
  ledger: Ledger | null | undefined
): MissingSymbol[]
