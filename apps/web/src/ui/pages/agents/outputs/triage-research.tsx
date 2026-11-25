/**
 * `triage-research`'s answer: the Markdown answer, the documents it used, and HOW the run got
 * there — the route its decisions chose and how much of the search the screen kept. The per-passage
 * probabilities are the `Relevance screen` artifact; each decision is a row in the timeline.
 */
import {
  type TriageResearchOutput,
  triageResearchOutputSchema,
} from '@rocketflare/shared/ai/agents'
import { Markdown } from '@/ui/components/ai/Markdown'
import { Provenance } from '@/ui/components/shared'
import { useCitationSources } from './citationSources'
import type { AgentOutput, AgentOutputProps } from './types'

const ROUTE_LABEL: Record<TriageResearchOutput['route'], string> = {
  answered: 'Answered from the screened passages',
  not_covered: 'Not covered by the knowledge base',
  escalated: 'Escalated to the research agent',
}

function TriageResearchOutputView({ output }: AgentOutputProps<TriageResearchOutput>) {
  const sources = useCitationSources(output.citations)
  return (
    <div>
      <p className="mb-3">
        <span
          className={`badge badge-sm ${output.route === 'escalated' ? 'badge-warning' : 'badge-ghost'}`}
        >
          {ROUTE_LABEL[output.route]}
        </span>
      </p>
      <Markdown content={output.answer} spacing="reading" className="text-sm max-w-[72ch]" />
      <Provenance
        sources={sources}
        work={{
          summary: `Screened ${output.screened} ${output.screened === 1 ? 'passage' : 'passages'} and kept ${output.kept} — each decision is in the timeline.`,
        }}
      />
    </div>
  )
}

export const triageResearchOutput: AgentOutput<TriageResearchOutput> = {
  schema: triageResearchOutputSchema,
  Component: TriageResearchOutputView,
}
