/** Types for `design-site-lib.mjs` (no `allowJs`); `apps/web/tests/config/design-site.test.ts` typechecks against this. */
import type { BrandResult } from './brand.mjs'
import type { Theme, ThemeKind } from './contrast.mjs'

export const GENERATOR_META: string
export function orderPages(files: string[]): string[]
export function pageNames(ordered: string[]): Map<string, string>
export function resolveLink(dest: string, names: Map<string, string>): string | null
export function webFont(stack: string | undefined): string | null
export function googleFontsHref(fonts: Array<string | null>): string | null
export function siteTokens(inputs: {
  tokensCss: string
  indexCss: string
  brandCss?: string | null
}): { themes: Record<ThemeKind, Theme>; fonts: Record<string, string>; brand: BrandResult | null }
export function stylesheet(tokens: {
  themes: Record<ThemeKind, Theme>
  fonts: Record<string, string>
}): string
export interface SiteInputs {
  pages: Array<{ file: string; source: string }>
  diagrams: Map<string, string>
  tokensCss: string
  indexCss: string
  brandCss?: string | null
  logo: string
  appName?: string
}
export function planSite(inputs: SiteInputs): {
  files: Map<string, string>
  warnings: string[]
  contrastTokens: Record<ThemeKind, Theme>
}
