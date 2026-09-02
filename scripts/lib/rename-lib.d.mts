/**
 * Hand-written types for `rename-lib.mjs` (the workspace has no `allowJs`). Keep in step with
 * the exports there; `apps/web/tests/config/rename-lib.test.ts` is what typechecks against this.
 */

export interface KitNames {
  readonly slug: string
  readonly upper: string
  readonly display: string
  readonly domains: readonly string[]
  readonly preserved: readonly string[]
}
export const KIT: KitNames

export const SLUG_RE: RegExp
export const HEX_COLOUR_RE: RegExp

export function validateSlug(slug: unknown): string | null
export function titleCase(slug: string): string

export interface DeriveOptions {
  domain?: string
  colour?: string
}
export interface Names {
  readonly slug: string
  readonly snake: string
  readonly upper: string
  readonly display: string
  readonly domain: string
  /** `<snake>_` — the API-key prefix as stored. */
  readonly prefix: string
  readonly colour: string | null
}
export function deriveNames(slug: string, display?: string, options?: DeriveOptions): Names

export type ClassId =
  | 'scope'
  | 'env'
  | 'domain'
  | 'cfgdir'
  | 'dbuser'
  | 'snake'
  | 'kebab'
  | 'display'
  | 'bare'
export interface ReplacementClass {
  id: ClassId
  label: string
  pattern: RegExp
  replacement: string
}
export function buildReplacements(names: Names): ReplacementClass[]
export const CLASS_IDS: readonly ClassId[]

export interface ReplacementResult {
  /** The same string instance as the input when nothing matched. */
  text: string
  counts: Record<ClassId, number>
  total: number
  /** Occurrences of `KIT.preserved` literals that were protected. */
  preserved: number
}
export function applyReplacements(text: string, names: Names): ReplacementResult

export const EXCLUDED_DIRS: readonly string[]
export const EXCLUDED_PATHS: readonly string[]
export const OPT_IN_IGNORED_PATHS: readonly string[]
export function isExcluded(relPath: string): boolean
export function isBinary(buffer: Uint8Array): boolean

export const API_KEY_HANDLE_MARGIN: number
export const REDACTED_KEY_MARGIN: number
export interface GuardValue {
  current: number | null
  required: number
  change: boolean
}
export interface PrefixGuard {
  prefix: string
  prefixLength: number
  apiKeyPrefixLength: GuardValue
  redactedKeyChars: GuardValue
}
export function prefixGuard(
  names: Names,
  current: { apiKeyPrefixLength?: number | null; redactedKeyChars?: number | null }
): PrefixGuard
export function readIntConstant(source: string, name: string): number | null
export function rewriteIntConstant(
  source: string,
  name: string,
  value: number,
  prefix: string,
  margin: number
): string
export function rewritePrefixComments(source: string, prefix: string, margin: number): string

export function hexToRgb(hex: string): string
export interface ColourResult {
  css: string
  html: string
  from: string
  to: string
  cssReplacements: number
  htmlReplaced: boolean
  manual: string[]
}
export function applyColour(files: { css: string; html: string }, colour: string): ColourResult

export const USAGE: string
export interface ParsedArgs {
  dryRun: boolean
  force: boolean
  skipInstall: boolean
  domain: string | undefined
  colour: string | undefined
  slug: string
  display: string | undefined
}
export function parseArgs(argv: string[]): ParsedArgs | { error: string } | { help: true }
