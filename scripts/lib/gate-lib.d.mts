/**
 * Hand-written types for `gate-lib.mjs` (the workspace has no `allowJs`). Keep in step with the
 * exports there; `apps/web/tests/config/gate.test.ts` is what typechecks against this.
 */

export const GATE_LIST_SCHEMA_VERSION: 1

export interface GateStepDefinition {
  readonly id: string
  readonly command: readonly string[]
  readonly display: string
  readonly database: boolean
}
export const GATE_STEPS: readonly GateStepDefinition[]
export const GATE_USAGE: string

export function gateList(): {
  schema: 1
  steps: Array<{ id: string; command: string; database: boolean }>
}

export function parseGateArgs(
  argv: string[]
):
  | { list: boolean; json: boolean; keepGoing: boolean; steps: string[] }
  | { error: string }
  | { help: true }
