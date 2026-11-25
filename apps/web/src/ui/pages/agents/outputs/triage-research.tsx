/**
 * `triage-research`'s answer: the Markdown answer, the documents it used, and HOW the run got
 * there — the route its decisions chose and how much of the search the screen kept. The per-passage
 * probabilities are the `Relevance screen` artifact; each decision is a row in the timeline.
 */
import {
  type TriageResearchOutput,
  triageResearchOutputSchema,
} from '@rocketflare/shared/ai/agents'
import { documentPath } from '@rocketflare/shared/ai/embeddings'
import { Markdown } from '@/ui/components/ai/Markdown'
import { DocumentLink } from '@/ui/components/shared'
import type { AgentOutput, AgentOutputProps } from './types'

const ROUTE_LABEL: Record<TriageResearchOutput['route'], string> = {
  answered: 'Answered from the screened passages',
  not_covered: 'Not covered by the knowledge base',
  escalated: 'Escalated to the research agent',
}

function TriageResearchOutputView({ output }: AgentOutputProps<TriageResearchOutput>) {
  return (
    <div className="space-y-4">
      <p className="flex flex-wrap items-center gap-2 text-xs text-secondary">
        <span
          className={`badge badge-sm ${output.route === 'escalated' ? 'badge-warning' : 'badge-ghost'}`}
        >
          {ROUTE_LABEL[output.route]}
        </span>
        <span>
          {output.kept} of {output.screened} passages kept
        </span>
      </p>
      <Markdown content={output.answer} className="text-sm" />
      {output.citations.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-1">Sources</h3>
          <ul className="space-y-0.5">
            {output.citations.map(citation => (
              <li key={citation.documentId} className="min-w-0">
                <DocumentLink
                  id={citation.documentId}
                  to={documentPath(citation.documentId)}
                  title={citation.title}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export const triageResearchOutput: AgentOutput<TriageResearchOutput> = {
  schema: triageResearchOutputSchema,
  Component: TriageResearchOutputView,
}
