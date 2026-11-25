/** Types for `brand.mjs` (no `allowJs`); `apps/web/tests/kit-only/design-docs.test.ts` typechecks against this. */
export type BlockKind = 'theme' | 'light' | 'dark'
export function tokenBlocks(
  css: string
): Array<{ kind: BlockKind; name: string | null; start: number; end: number }>
export function parseBrand(brandCss: string | null | undefined): {
  overrides: Record<BlockKind, Record<string, string>>
  problems: string[]
}
export function setDeclaration(body: string, prop: string, value: string): string | null
export interface BrandResult {
  tokensCss: string
  indexCss: string
  indexHtml: string | null
  applied: Array<{ kind: BlockKind; prop: string; value: string; files: string[] }>
  unknown: string[]
  warnings: string[]
  problems: string[]
  /** Set when brand.css carried `--brand-hue`: the hue the palette was turned from and to. */
  hue: { from: number; to: number; rotated: number } | null
}
export function applyBrand(
  files: { tokensCss: string; indexCss: string; indexHtml?: string | null },
  brandCss: string
): BrandResult
export function themeDeclarations(css: string): Record<string, string>
export const FIXED_HUE_TOKENS: string[]
export const BRAND_HUE: string
export function brandHue(css: string): number | null
export function rotateHue(css: string, delta: number): { css: string; rotated: number }
export function hueOf(colour: string): { hue: number; error?: undefined } | { error: string; hue?: undefined }
export function hexOf(value: string): string | null
export function setThemeColor(html: string, colour: string): string
export interface HueResult {
  tokensCss: string
  indexCss: string
  indexHtml: string | null
  from: number
  to: number
  rotated: number
  primary: string | null
}
export function applyHue(
  files: { tokensCss: string; indexCss: string; indexHtml?: string | null },
  hue: number
): HueResult
export interface LookFiles {
  tokensCss: string
  indexCss: string
  indexHtml?: string | null
}
export function adoptDefaultLook(inputs: {
  current: LookFiles
  defaults: LookFiles
  brandCss?: string | null
}): {
  tokensCss: string
  indexCss: string
  indexHtml: string | null
  /** `<file> <block> <prop>` for each of the app's own tokens kept beside the defaults. */
  kept: string[]
  missing: string[]
  brand: BrandResult | null
}
