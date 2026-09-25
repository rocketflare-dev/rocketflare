/**
 * Hand-written types for `update-check-lib.mjs` (the workspace has no `allowJs`). Keep in step with
 * the exports there; `apps/web/tests/config/update-check-lib.test.ts` typechecks against this.
 */
import type { Manifest } from './upgrade-lib.d.mts'

export const CACHE_TTL_MS: number
export const FAILURE_TTL_MS: number
export const OPT_OUT_ENV: string
export const MAX_LISTED: number

export interface UpdateCache {
  repo: string
  /** The copy's `kit.version` when this was checked. */
  current: string
  checkedAt: number
  latest: string | null
  summaries: ReleaseSummary[]
  /** The remote could not be reached; retried after `FAILURE_TTL_MS`, not the full day. */
  failed?: boolean
}

export interface ReleaseSummary {
  version: string
  summary: string
}

export function skipReason(input: {
  source?: string
  manifest: Manifest | null
  env: Record<string, string | undefined>
}): string | null
export function freshCache(
  cache: UpdateCache | null,
  opts: { repo: string; current: string; now: number }
): UpdateCache | null
export function latestVersion(lines: string[]): string | null
export function rawFileUrl(repo: string, ref: string, file: string): string | null
export function changelogSummaries(text: string, from: string, to: string): ReleaseSummary[]
export function updateMessage(input: {
  current: string
  latest: string | null
  summaries: ReleaseSummary[]
}): string | null
