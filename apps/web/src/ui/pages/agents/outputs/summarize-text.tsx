/**
 * `summarize-text`'s answer (D7, D17, D18): the summary as Markdown, its key points, and a link to
 * the indexed document when the run was asked to store it. Parsed with the SAME
 * `summarizeTextOutputSchema` the runtime validated the output against.
 */
import { DocumentMagnifyingGlassIcon } from '@heroicons/react/24/outline'
import { type SummarizeTextOutput, summarizeTextOutputSchema } from '@rocketflare/shared/ai/agents'
import type { AgentArtifact } from '@rocketflare/shared/ai/artifacts'
import { documentPath } from '@rocketflare/shared/ai/embeddings'
import { Link } from 'react-router-dom'
import { Markdown } from '@/ui/components/ai/Markdown'
import type { AgentOutput, AgentOutputProps } from './types'

function SummarizeTextOutputView({ output }: AgentOutputProps<SummarizeTextOutput>) {
  return (
    <div className="space-y-4">
      <Markdown content={output.summary} className="text-sm" />
      {output.keyPoints.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-1">Key points</h3>
          <ul className="list-disc pl-5 text-sm space-y-0.5">
            {output.keyPoints.map(point => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </div>
      )}
      {output.documentId && (
        <Link
          to={documentPath(output.documentId)}
          className="link link-primary text-sm inline-flex items-center gap-1.5"
        >
          <DocumentMagnifyingGlassIcon className="w-4 h-4" />
          Open the indexed document
        </Link>
      )}
    </div>
  )
}

export const summarizeTextOutput: AgentOutput<SummarizeTextOutput> = {
  schema: summarizeTextOutputSchema,
  Component: SummarizeTextOutputView,
  // The fallback for a run that predates `ctx.artifact()`: the summary is a thing you open, so it
  // belongs on the Artifacts tab whether or not the agent declared it.
  artifacts: (output, runId): AgentArtifact[] => {
    const at = new Date(0)
    const base = { tenantId: runId, runId, description: null, createdAt: at, updatedAt: at }
    const derived: AgentArtifact[] = [
      {
        ...base,
        id: `${runId}:summary`,
        key: 'summary',
        kind: 'markdown',
        title: 'Summary',
        data: { kind: 'markdown', markdown: output.summary },
      },
    ]
    if (output.documentId) {
      derived.push({
        ...base,
        id: `${runId}:document`,
        key: 'document',
        kind: 'document',
        title: 'Indexed document',
        data: { kind: 'document', documentId: output.documentId },
      })
    }
    return derived
  },
}
