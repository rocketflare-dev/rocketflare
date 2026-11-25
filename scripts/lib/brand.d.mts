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
}
export function applyBrand(
  files: { tokensCss: string; indexCss: string; indexHtml?: string | null },
  brandCss: string
): BrandResult
export function themeDeclarations(css: string): Record<string, string>
