/**
 * `research-topic`'s answer: the Markdown answer and the documents it actually drew on.
 * Citations are filtered server-side against what the tools returned, so a title here is a document
 * the run really read — the link opens the viewer, not a search narrowed to it.
 */
import { type ResearchTopicOutput, researchTopicOutputSchema } from '@rocketflare/shared/ai/agents'
import type { AgentArtifact } from '@rocketflare/shared/ai/artifacts'
import { Markdown } from '@/ui/components/ai/Markdown'
import { Provenance } from '@/ui/components/shared'
import { useCitationSources } from './citationSources'
import type { AgentOutput, AgentOutputProps } from './types'

function ResearchTopicOutputView({ output }: AgentOutputProps<ResearchTopicOutput>) {
  const sources = useCitationSources(output.citations)
  const turns = `${output.turns} model ${output.turns === 1 ? 'turn' : 'turns'}`
  return (
    <div>
      <Markdown content={output.answer} spacing="reading" className="text-sm max-w-[72ch]" />
      {output.citations.length === 0 && (
        <p className="mt-3 text-sm text-muted">
          Nothing in the knowledge base answered this question.
        </p>
      )}
      <Provenance
        sources={sources}
        work={{
          summary:
            output.citations.length > 0
              ? `Read ${output.citations.length} ${output.citations.length === 1 ? 'document' : 'documents'} in ${turns}.`
              : `Searched in ${turns}.`,
        }}
      />
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
