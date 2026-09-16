/**
 * `research-topic`'s answer (D7, D18): the Markdown answer and the documents it actually drew on.
 * Citations are filtered server-side against what the tools returned, so a title here is a document
 * the run really read — the link opens the viewer, not a search narrowed to it.
 */
import { DocumentMagnifyingGlassIcon } from '@heroicons/react/24/outline'
import { type ResearchTopicOutput, researchTopicOutputSchema } from '@rocketflare/shared/ai/agents'
import type { AgentArtifact } from '@rocketflare/shared/ai/artifacts'
import { documentPath } from '@rocketflare/shared/ai/embeddings'
import { Link } from 'react-router-dom'
import { Markdown } from '@/ui/components/ai/Markdown'
import type { AgentOutput, AgentOutputProps } from './types'

function ResearchTopicOutputView({ output }: AgentOutputProps<ResearchTopicOutput>) {
  return (
    <div className="space-y-4">
      <Markdown content={output.answer} className="text-sm" />
      <div>
        <h3 className="text-sm font-medium mb-1">
          {output.citations.length > 0 ? 'Sources' : 'No sources'}
        </h3>
        {output.citations.length > 0 ? (
          <ul className="text-sm space-y-0.5">
            {output.citations.map(citation => (
              <li key={citation.documentId}>
                <Link
                  to={documentPath(citation.documentId)}
                  className="link link-primary inline-flex items-center gap-1.5"
                >
                  <DocumentMagnifyingGlassIcon className="w-4 h-4" />
                  {citation.title}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">
            The agent found nothing in the knowledge base for this question.
          </p>
        )}
      </div>
      <p className="text-xs text-muted">{output.turns} model turn(s)</p>
    </div>
  )
}

export const researchTopicOutput: AgentOutput<ResearchTopicOutput> = {
  schema: researchTopicOutputSchema,
  Component: ResearchTopicOutputView,
  artifacts: (output, runId): AgentArtifact[] => {
    const at = new Date(0)
    return [
      {
        id: `${runId}:answer`,
        tenantId: runId,
        runId,
        key: 'answer',
        kind: 'markdown',
        title: 'Answer',
        description: null,
        data: { kind: 'markdown', markdown: output.answer },
        createdAt: at,
        updatedAt: at,
      },
    ]
  },
}
