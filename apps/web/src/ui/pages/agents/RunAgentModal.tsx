/**
 * "Run <agent>" (D7, D17, D20): the agent's form from the registry (`forms/`), parsed with its
 * shared input schema on submit, then `POST /api/agents/runs` → 202. A `deduplicated` answer is
 * still a run — the hook toasts and the caller navigates to it. A 503 `agent_runs_not_configured`
 * replaces the form with the explanatory empty state (the Workflow binding is a deployment fact,
 * not something the reader can fix here); a 400 with zod issues maps back onto the fields.
 */

import { CpuChipIcon, PlayIcon } from '@heroicons/react/24/outline'
import type { AgentInfo, CreateAgentRunResponse } from '@rocketflare/shared/ai/agents'
import { type FormEvent, useState } from 'react'
import { EmptyState, Modal } from '@/ui/components/shared'
import { isAgentRunsNotConfigured, useCreateAgentRun } from '@/ui/hooks/useAgents'
import { ApiError } from '@/ui/lib/api-client'
import { formFor } from './forms'

type Issue = { path: PropertyKey[]; message: string }

/** zod issues the server put in `details` (validation_failed), if that is what they are. */
function issuesFrom(error: unknown): Issue[] | undefined {
  if (!(error instanceof ApiError) || !Array.isArray(error.details)) return undefined
  const issues = error.details.filter(
    (d): d is Issue =>
      typeof d === 'object' && d !== null && Array.isArray((d as Issue).path) && 'message' in d
  )
  return issues.length > 0 ? issues : undefined
}

export function RunAgentModal({
  agent,
  onClose,
  onStarted,
}: {
  /** The agent to run; `null` closes the modal. */
  agent: AgentInfo | null
  onClose: () => void
  onStarted: (run: CreateAgentRunResponse) => void
}) {
  return (
    <Modal
      open={agent !== null}
      onClose={onClose}
      title={agent ? `Run ${agent.title}` : 'Run agent'}
      className="max-w-2xl"
      actions={
        agent ? (
          <>
            <button type="button" className="btn btn-sm" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" form="run-agent-form" className="btn btn-sm btn-primary gap-1.5">
              <PlayIcon className="w-4 h-4" />
              Run
            </button>
          </>
        ) : null
      }
    >
      {agent && <RunAgentForm key={agent.key} agent={agent} onStarted={onStarted} />}
    </Modal>
  )
}

function RunAgentForm({
  agent,
  onStarted,
}: {
  agent: AgentInfo
  onStarted: (run: CreateAgentRunResponse) => void
}) {
  const form = formFor(agent.key)
  const create = useCreateAgentRun()
  const [draft, setDraft] = useState<unknown>(form.initial)
  const [issues, setIssues] = useState<Issue[] | undefined>()

  if (isAgentRunsNotConfigured(create.error)) {
    return (
      <EmptyState
        icon={CpuChipIcon}
        size="sm"
        message="Agent runs are not configured"
        description="This deployment has no AGENT_RUN_WORKFLOW binding, so runs cannot be started. An operator enables it in wrangler.toml (see the deploy runbook)."
      />
    )
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const parsed = form.schema.safeParse(draft)
    if (!parsed.success) return setIssues(parsed.error.issues)
    setIssues(undefined)
    create.mutate(
      { agentKey: agent.key, input: parsed.data },
      {
        onSuccess: onStarted,
        onError: error => setIssues(issuesFrom(error)),
      }
    )
  }

  return (
    <form id="run-agent-form" onSubmit={submit} className="space-y-3" noValidate>
      <p className="text-sm text-secondary">{agent.description}</p>
      <form.Component
        value={draft}
        onChange={setDraft}
        issues={issues}
        disabled={create.isPending}
      />
      {agent.exclusive && (
        <p className="text-xs text-muted">
          One at a time: if this agent is already queued or running for this organisation, you are
          taken to that run instead.
        </p>
      )}
      {create.isPending && (
        <p className="text-xs text-muted" role="status">
          Starting…
        </p>
      )}
    </form>
  )
}
