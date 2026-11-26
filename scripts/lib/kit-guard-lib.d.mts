/** Types for `kit-guard-lib.mjs` (no `allowJs`); `apps/web/tests/config/kit-guard-lib.test.ts` typechecks against this. */
import type { GuardRule, GuardTier } from './kit-guard-rules.d.mts'
import type { UiFinding } from './ui-lint.d.mts'

export interface LocalEdit {
  path: string
  kind: 'fix' | 'change'
  reason: string
  seamConsidered: string
  capability?: string
  date: string
}
/** The slice of `.rocketflare.json` the guard reads. */
export interface GuardManifest {
  app?: unknown
  kit?: { repo?: string | null } | null
  guard?: { enabled?: boolean } | null
  localEdits?: unknown[]
  surfaces?: Array<{ kind?: string; paths?: string[] }>
}
export interface GuardSettings {
  lint: boolean
  core: boolean
}
export interface GuardState {
  v: number
  steered: string[]
  post: Record<string, string>
  stopBlocked: string[]
  reflexAsked: string[]
}
export interface Carrier {
  name: string
  note?: string
  paths: string[]
}
export interface PorcelainChange {
  status: string
  path: string
}

export const REASON_MIN: number
export function guardSettings(
  manifest: GuardManifest | null,
  env?: Record<string, string | undefined>
): GuardSettings
export function toRepoPath(roots: string | readonly string[], filePath: unknown): string | null
export function classifyGuardPath(
  rel: string,
  manifest?: GuardManifest | null,
  rules?: readonly GuardRule[]
): { tier: GuardTier; rule: GuardRule | null }
export function ledgerOf(manifest: GuardManifest | null): unknown[]
export function ledgerEntryFor(manifest: GuardManifest | null, rel: string): LocalEdit | null
export function ledgerProblems(entry: unknown): string[]
export function validLedgerEntry(manifest: GuardManifest | null, rel: string): LocalEdit | null
export function carriedPaths(diffText: unknown): string[]
export function carrierFor(carriers: readonly Carrier[] | null | undefined, rel: string): Carrier | null
export const RETRY_LINE: string
export function steerGuidance(
  rule: GuardRule,
  rel: string,
  options?: { carrier?: Carrier | null; entry?: LocalEdit | null; repo?: string | null }
): string
export function sealedReason(rule: GuardRule, rel: string): string
export function sessionStartText(settings: { core: boolean }): string
export function postToolText(rel: string, findings: readonly UiFinding[]): string | null
export function normaliseState(raw: unknown): GuardState
export function stateName(sessionId: unknown): string
export function fingerprint(items: readonly string[]): string
export function parsePorcelain(text: unknown): PorcelainChange[]
export function changesTrackedFile(status: string): boolean
export function preToolDecision(input: {
  rel: string | null
  manifest: GuardManifest | null
  state: unknown
  settings: GuardSettings
  exists: boolean
  carriers?: readonly Carrier[]
}): {
  decision: { kind: 'deny'; reason: string; steer?: true } | null
  state: GuardState
}
export function postToolDecision(input: {
  rel: string | null
  findings: readonly UiFinding[]
  state: unknown
  settings: GuardSettings
}): { context: string | null; state: GuardState }
export function stopDecision(input: {
  changes: readonly PorcelainChange[]
  manifest: GuardManifest | null
  findings: readonly UiFinding[]
  state: unknown
  settings: GuardSettings
  stopHookActive: boolean
  carriers?: readonly Carrier[]
}): { block: string | null; notice: string | null; state: GuardState }
export function denyOutput(reason: string): string
export function guideOutput(event: string, context: string): string
export function blockOutput(reason: string): string
export function noticeOutput(text: string): string
