/**
 * Hand-written types for `test-plan.mjs` (the workspace has no `allowJs`). Keep in step with the
 * exports there; `apps/web/tests/kit-only/gate.test.ts` is what typechecks against this.
 */

export type TestTarget = 'local' | 'remote'
export type TestDriver = 'postgres' | 'neon'
type Env = Record<string, string | undefined>

export const PROXY_URL: string
export const COMPOSE_FILE: string
export const WEB_DIR: string
export const TARGET_HINT: string

export function resolveTarget(
  env: Env
): { target: TestTarget; suiteDriver: TestDriver } | { error: string }

export interface TestStep {
  label: string
  /** Relative to the repository root. */
  cwd: string
  command: string[]
  env: Record<string, string>
}

export interface TestPlan {
  target: TestTarget
  suiteDriver: TestDriver
  /** Start the compose database (and the Neon proxy) before the steps. */
  compose: boolean
  banner: string
  steps: TestStep[]
  notes: string[]
}

export const SUITES: Record<'api' | 'ui' | 'config' | 'driver' | 'kit-only', string[]>

export function planTests(
  env: Env,
  tree: { kitOnly: boolean; webOnly?: boolean }
): TestPlan | { error: string }

export function planSuites(
  env: Env,
  input: { suites: string[]; files: string[]; kitOnly: boolean }
): TestPlan | { error: string }

export function planSelectedTests(
  env: Env,
  selection: { projects: Record<string, string[]>; packages: string[] }
): TestPlan | { error: string }
