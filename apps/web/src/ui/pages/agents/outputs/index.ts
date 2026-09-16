/**
 * Output registry keyed by `agentKey` (issue #17), the twin of `forms/`.
 *
 * **An agent in this kit is one shared input schema + one `forms/` entry + one `outputs/` entry.**
 * Before this, the run surface hard-coded `agentKey === 'summarize-text'` and
 * `agentKey === 'research-topic'` inside one component, which is exactly the shape that makes an
 * app's third agent a diff against kit code rather than a new file beside it.
 *
 * An agent with no entry gets the raw JSON view, which is a real answer rather than an apology: the
 * output is a validated object and reading it is sometimes the whole point.
 */
import type { AgentKey } from '@rocketflare/shared/ai/agents'
import { researchTopicOutput } from './research-topic'
import { summarizeTextOutput } from './summarize-text'
import type { AgentOutput } from './types'

const AGENT_OUTPUTS: Partial<Record<AgentKey, AgentOutput>> = {
  'summarize-text': summarizeTextOutput as AgentOutput,
  'research-topic': researchTopicOutput as AgentOutput,
}

/** `undefined` means "no typed view" — the caller renders the JSON. */
export function outputFor(agentKey: string): AgentOutput | undefined {
  return AGENT_OUTPUTS[agentKey as AgentKey]
}

export type { AgentOutput, AgentOutputProps } from './types'
