/**
 * `/agents/runs`: every run the caller may see, across agents — the agent and status filters, and
 * `?awaiting=1`, the link the "waiting on you" button and badges point at.
 */
import { PageHeader } from '@/ui/components/shared'
import { useAgentList } from '@/ui/hooks/useAgents'
import { RunsTable } from './RunsTable'

export default function AllRunsPage() {
  const agents = useAgentList()
  const items = agents.data?.items ?? []
  const titleOf = (key: string) => items.find(a => a.key === key)?.title ?? key
  return (
    <div className="space-y-4">
      <PageHeader
        title="All runs"
        breadcrumbs={[{ label: 'Agents', to: '/agents' }, { label: 'All runs' }]}
      />
      <RunsTable titleOf={titleOf} title="Runs" />
    </div>
  )
}
