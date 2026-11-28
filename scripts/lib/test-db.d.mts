/**
 * Hand-written types for `test-db.mjs` (the workspace has no `allowJs`). Keep in step with the
 * exports there; `apps/web/tests/kit-only/test-db.test.ts` typechecks against this.
 */
type Env = Record<string, string | undefined>

export const CHECKOUT_ROOT: string
export const ENV_TEST_FILE: string
export const COMMENT_PREFIX: string
export function checkoutPath(root?: string): string
export function checkoutHash(realPath: string): string
export function envTestDatabaseName(envTestText: string | null | undefined): string | null
export function checkoutDatabaseName(base: string, realPath: string): string
export function rewriteDatabaseUrl<T extends string | undefined>(url: T, base: string, name: string): T
export function applyCheckoutDatabase(
  env: Env,
  options?: { root?: string; envTestText?: string }
): { base: string; name: string; path: string } | null
export function checkoutComment(realPath: string): string
export function parseCheckoutComment(comment: string | null | undefined): string | null
export function planPrune(
  databases: { name: string; comment: string | null }[],
  exists: (path: string) => boolean
): {
  live: { name: string; checkout: string }[]
  stale: { name: string; checkout: string }[]
}
