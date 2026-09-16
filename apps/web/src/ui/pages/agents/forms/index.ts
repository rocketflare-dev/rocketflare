/**
 * Form registry keyed by `agentKey` (D7, issue #17). **Adding an agent to the kit is one shared
 * input schema + one entry here + one `outputs/` entry** — two registries keyed the same way, which
 * is the right amount of ceremony: one combined map would make the run MODAL's chunk and the run
 * PAGE's chunk pull each other's components.
 *
 * `formFor` is three rungs, in order:
 *
 * 1. a **registered** form — hand-written, with the agent's own copy, counters and affordances;
 * 2. **`schemaForm(inputJsonSchema)`** — built from the agent's own schema, which the server
 *    already converts for the tool loop, so an app's agent gets real fields for free;
 * 3. **`jsonForm`** — a JSON textarea whose only client-side check is "parses". The route validates
 *    with the agent's `inputSchema` and answers 400 with field issues either way.
 */
import type { AgentInfo, AgentKey } from '@rocketflare/shared/ai/agents'
import { z } from 'zod'
import { JsonForm } from './JsonForm'
import { researchTopicForm } from './research-topic'
import { schemaForm } from './SchemaForm'
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
  'research-topic': researchTopicForm as AgentForm,
}

export function formFor(agent: Pick<AgentInfo, 'key' | 'inputJsonSchema'> | AgentKey): AgentForm {
  if (typeof agent === 'string') return AGENT_FORMS[agent] ?? (jsonForm as AgentForm)
  const registered = AGENT_FORMS[agent.key]
  if (registered) return registered
  return (schemaForm(agent.inputJsonSchema) as AgentForm | null) ?? (jsonForm as AgentForm)
}

export { schemaForm } from './SchemaForm'
export type { AgentForm, AgentFormProps } from './types'
