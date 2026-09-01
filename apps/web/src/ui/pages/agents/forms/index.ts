/**
 * Form registry keyed by `agentKey` (D7). An agent with no entry gets `jsonForm`: a JSON textarea
 * whose only client-side check is "parses" — the route validates the body with the agent's own
 * `inputSchema` and answers 400 with field issues, which the modal surfaces. Adding an agent to the
 * kit = one shared input schema + one entry here.
 */
import type { AgentKey } from '@rocketflare/shared/ai/agents'
import { z } from 'zod'
import { JsonForm } from './JsonForm'
import { summarizeTextForm } from './summarize-text'
import type { AgentForm } from './types'

/** Draft for the fallback: the raw JSON text; the schema turns it into the posted `input`. */
export const jsonForm: AgentForm<string> = {
  initial: '{\n  \n}',
  schema: z.string().transform((raw, ctx) => {
    try {
      return JSON.parse(raw) as unknown
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Input must be valid JSON' })
      return z.NEVER
    }
  }),
  Component: JsonForm,
}

const AGENT_FORMS: Partial<Record<AgentKey, AgentForm>> = {
  'summarize-text': summarizeTextForm as AgentForm,
}

export function formFor(agentKey: AgentKey): AgentForm {
  return AGENT_FORMS[agentKey] ?? (jsonForm as AgentForm)
}

export type { AgentForm, AgentFormProps } from './types'
