/** Types for `kit-guard-rules.mjs` (no `allowJs`). */
export type GuardTier = 'open' | 'steer' | 'sealed'
export interface GuardRule {
  id: string
  tier: GuardTier
  paths: string[]
  why: string
  /** steer: the seam to reach for first (or a plain "there is no seam"). */
  instead?: string
  /** sealed: the command that regenerates the file. */
  regenerate?: string
}
export const GUARD_RULES: GuardRule[]
export const TIER_ORDER: GuardTier[]
