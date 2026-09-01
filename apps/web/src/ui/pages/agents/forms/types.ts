/**
 * The per-agent input form contract (D7). An agent's request body is validated at the route with
 * its own `inputSchema`, so each form ships the SAME shared schema and parses the draft with it
 * before posting; `RunAgentModal` owns the draft, the form only renders and reports field issues.
 */
import type { ComponentType } from 'react'
import type { z } from 'zod'

export interface AgentFormProps<Draft = unknown> {
  value: Draft
  onChange: (value: Draft) => void
  /** zod issues from the last failed submit, for `fieldErrorFor`. */
  issues?: readonly { path: readonly PropertyKey[]; message: string }[]
  disabled?: boolean
}

export interface AgentForm<Draft = unknown> {
  initial: Draft
  /** The shared input schema; its OUTPUT is what gets posted as `input`. */
  schema: z.ZodType<unknown, z.ZodTypeDef, unknown>
  Component: ComponentType<AgentFormProps<Draft>>
}
