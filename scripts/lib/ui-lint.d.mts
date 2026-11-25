/** Types for `ui-lint.mjs` (no `allowJs`); `apps/web/tests/config/ui-lint-lib.test.ts` typechecks against this. */
export type UiSeverity = 'ban' | 'reflex'
export interface UiRule {
  severity: UiSeverity
  message: string
  fix: string
}
export interface UiFinding {
  rule: string
  severity: UiSeverity
  file: string
  line: number
  message: string
  fix: string
}
export interface CssDeclaration {
  prop: string
  value: string
  line: number
}
export interface CssBlock {
  prelude: string
  line: number
  decls: CssDeclaration[]
}
export const UI_RULES: Record<string, UiRule>
export const RULE_IDS: string[]
export const TOKEN_FILES: string[]
export function isUiPath(rel: unknown): boolean
export function blankComments(text: string, options?: { css?: boolean }): string
export function shadowProblems(value: unknown): Array<'glow' | 'hard'>
export function allowComments(text: string): Array<{ line: number; rule: string | null; reason: string }>
export function lintTsx(text: string, file?: string): UiFinding[]
export function cssBlocks(code: string): CssBlock[]
export function lintCss(text: string, file?: string): UiFinding[]
export function lintSource(text: unknown, file: string): UiFinding[]
export function splitFindings(findings: readonly UiFinding[]): {
  bans: UiFinding[]
  reflexes: UiFinding[]
}
export function formatFinding(finding: UiFinding): string
