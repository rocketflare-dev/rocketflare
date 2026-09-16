/**
 * The per-agent OUTPUT contract, mirroring `forms/` (issue #17). An agent's `output` is validated
 * by the runtime against its own `outputSchema`, so each entry ships the SAME shared schema and
 * parses before rendering — a run written by an older build simply falls through to the raw JSON.
 *
 * `artifacts` is the zero-server-change fallback: an agent that never called `ctx.artifact()` can
 * still put its result on the Artifacts tab by deriving one from the output it already returns.
 */
import type { AgentArtifact } from '@rocketflare/shared/ai/artifacts'
import type { ComponentType } from 'react'
import type { z } from 'zod'

export interface AgentOutputProps<Output = unknown> {
  output: Output
  runId: string
}

export interface AgentOutput<Output = unknown> {
  schema: z.ZodType<Output, z.ZodTypeDef, unknown>
  Component: ComponentType<AgentOutputProps<Output>>
  /**
   * Artifacts derived from the output for an agent that declares none of its own. They are shaped
   * like table rows but never stored — `id` is synthesised from the run so React keys are stable.
   */
  artifacts?: (output: Output, runId: string) => AgentArtifact[]
}
