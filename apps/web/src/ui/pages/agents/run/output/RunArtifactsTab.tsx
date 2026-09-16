/**
 * The things this run produced that a person opens.
 *
 * Artifacts come from the TABLE (decision 4) — mutable, queryable across runs, outliving the run —
 * with the event rows supplying only the ORDER they appeared in. `outputFor().artifacts?.(output)`
 * is the zero-server-change fallback — used only when the table has none, so it can never duplicate
 * what an agent recorded for itself — and it is what keeps this tab useful for an agent that never
 * called `ctx.artifact()` (both shipped ones do).
 */
import { PaperClipIcon } from '@heroicons/react/24/outline'
import type { AgentArtifact } from '@rocketflare/shared/ai/artifacts'
import { EmptyState } from '@/ui/components/shared'
import { ArtifactView } from './ArtifactView'

export function RunArtifactsTab({ artifacts }: { artifacts: readonly AgentArtifact[] }) {
  if (artifacts.length === 0) {
    return (
      <EmptyState
        icon={PaperClipIcon}
        size="sm"
        message="No artifacts"
        description="An agent records a draft, a table or a document here with ctx.artifact()."
      />
    )
  }
  return (
    <div className="space-y-3">
      {artifacts.map(artifact => (
        <ArtifactView key={artifact.id} artifact={artifact} />
      ))}
    </div>
  )
}
