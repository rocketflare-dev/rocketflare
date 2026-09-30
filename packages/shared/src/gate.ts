/**
 * `pnpm gate --list --json` — the contract for anything that runs an app's gate step by step
 * (Launch's ship gate reads it to decide what to run; docs/CONCEPTS.md §4). `scripts/gate.mjs`
 * prints it and `apps/web/tests/config/gate.test.ts` parses that output with this schema.
 *
 * `schema` rises only when an existing field changes meaning. A new step or a new field is not a
 * schema change, so a reader must tolerate both. `steps` is in RUN order.
 */
import { z } from 'zod'

export const GATE_LIST_SCHEMA_VERSION = 1

export const gateStepSchema = z.object({
  /** What `pnpm gate <id>` runs: `lint`, `typecheck`, `test`, `build`. */
  id: z.string().regex(/^[a-z][a-z-]*$/),
  /** The command the step runs, for a human reading the list. */
  command: z.string().min(1),
  /** The step needs a test database: the local compose one, or the gate-branch variables. */
  database: z.boolean(),
})
export type GateStep = z.infer<typeof gateStepSchema>

export const gateListSchema = z.object({
  schema: z.literal(GATE_LIST_SCHEMA_VERSION),
  steps: z.array(gateStepSchema).min(1),
})
export type GateList = z.infer<typeof gateListSchema>
