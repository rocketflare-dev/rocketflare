/** Types for `contrast.mjs` (no `allowJs`); `apps/web/tests/ui/contrast.test.ts` typechecks against this. */
export type Rgb = [number, number, number]
export type ThemeKind = 'light' | 'dark'
export interface Theme {
  name: string | null
  tokens: Record<string, string>
}
export interface PairResult {
  fg: string
  bg: string
  floor: number
  fgValue: string | undefined
  bgValue: string | undefined
  ratio: number | null
  ok: boolean
  problem?: string
}
export interface EqualResult {
  a: string
  b: string
  aValue: string | undefined
  bValue: string | undefined
  ok: boolean
}
export function stripComments(css: string): string
export function declarations(body: string): Record<string, string>
export function themeKind(name: string | null | undefined): ThemeKind | null
export function themeTokens(css: string): Record<ThemeKind, Theme>
export function rgbToOklch(rgb: number[]): [number, number, number]
export function oklchText(rgb: number[]): string
export function parseColour(value: string): Rgb | null
export function contrastRatio(a: number[], b: number[]): number
export const SHELL_PAIRS: Array<[string, string, number]>
export function contrastPairs(): Array<[string, string, number]>
export const EQUAL_TOKENS: Array<[string, string]>
export function checkPair(
  tokens: Record<string, string>,
  fg: string,
  bg: string,
  floor: number
): PairResult
export function checkTheme(tokens: Record<string, string>): {
  pairs: PairResult[]
  equal: EqualResult[]
  failures: number
}
