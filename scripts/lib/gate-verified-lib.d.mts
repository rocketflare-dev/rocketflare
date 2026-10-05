/**
 * Hand-written types for `gate-verified-lib.mjs` (the workspace has no `allowJs`). Keep in step
 * with the exports there; `apps/web/tests/config/gate-verified.test.ts` typechecks against this.
 */

export const LAUNCH_GATE_CHECK: 'launch/gate'

export interface LookupContext {
  appId?: string
  eventName?: string
  ref?: string
  sha?: string
  prHeadSha?: string
}

export interface LookupPlan {
  lookup: true
  appId: number
  commits: string[]
  pullsOf: string | null
}

export function planLookup(ctx: LookupContext): { lookup: false; reason: string } | LookupPlan

/** `run` is a check run as the REST API returns it. */
export function isAttestation(run: unknown, want: { appId: number; tree: string }): boolean

export function findVerified(args: {
  tree: string
  plan: Pick<LookupPlan, 'appId' | 'commits' | 'pullsOf'>
  api: (path: string) => Promise<unknown>
}): Promise<{ verified: boolean; reason: string; commit?: string }>

export function githubApi(opts: {
  token: string
  repository: string
  apiUrl?: string
  fetch?: typeof fetch
}): (path: string) => Promise<unknown>
