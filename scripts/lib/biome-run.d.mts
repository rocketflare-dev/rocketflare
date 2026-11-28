/** Hand-written types for `biome-run.mjs` (the workspace has no `allowJs`). */
import type { SpawnSyncReturns } from 'node:child_process'

export function biomeBin(root: string): string
export function runBiome(
  root: string,
  args: readonly string[],
  options?: Record<string, unknown>
): SpawnSyncReturns<Buffer | string> | { status: number; error: Error; stdout: null }
export const BIOME_FILE_RE: RegExp
export function formatWritten(
  root: string,
  paths: readonly string[],
  options?: { warn?: (...lines: string[]) => void }
): string | null
