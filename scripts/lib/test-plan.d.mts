/**
 * Hand-written types for `test-plan.mjs` (the workspace has no `allowJs`). Keep in step with the
 * exports there; `apps/web/tests/kit-only/gate.test.ts` is what typechecks against this.
 */

export type TestTarget = 'local' | 'remote'
export type TestDriver = 'postgres' | 'neon'
type Env = Record<string, string | undefined>

export const DEFAULT_TEST_PORTS: Readonly<{ postgres: number; proxy: number }>
export function proxyUrl(port: number): string
export const PROXY_URL: string
/** The host ports `docker-compose.test.yml` publishes (the kit's when it does not say). */
export function testPorts(composeText: string): { postgres: number; proxy: number }
/** The port of `.env.test`'s `DATABASE_URL`, or null. */
export function envTestDatabasePort(envTestText: string): number | null
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
  tree: { kitOnly: boolean; webOnly?: boolean; proxy?: string }
): TestPlan | { error: string }

export function planSuites(
  env: Env,
  input: { suites: string[]; files: string[]; kitOnly: boolean; proxy?: string }
): TestPlan | { error: string }

export function planSelectedTests(
  env: Env,
  selection: { projects: Record<string, string[]>; packages: string[]; proxy?: string }
): TestPlan | { error: string }
