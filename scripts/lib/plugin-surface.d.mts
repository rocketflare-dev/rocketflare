/**
 * Hand-written types for `plugin-surface.mjs` (no `allowJs`). Keep in step with its exports;
 * `apps/web/tests/kit-only/plugin-surface.test.ts` typechecks against this.
 */
import type { LedgerEntry } from './surface.d.mts'

export const SURFACE_JSON: string
export const ENTRY_ROLES: Readonly<Record<string, string>>
export const EXPANDED: ReadonlySet<string>
export function expands(name: string): boolean

/** One member the kit provides: a top-level export, or `Type.member` with kind `member`. */
export interface SurfaceMember {
  entry: string
  kind: string
  name: string
}

export interface DeclaredSurface {
  entries: Array<LedgerEntry & { role: string }>
  members: SurfaceMember[]
  /** Every name → the entries that provide it, in ledger order. */
  moved: Record<string, string[]>
  aliases: Record<string, string>
}

export function readDeclaredSurface(
  repoRoot: string,
  options?: { entries?: readonly LedgerEntry[] }
): DeclaredSurface
export function renderSurfaceJson(surface: DeclaredSurface): string
