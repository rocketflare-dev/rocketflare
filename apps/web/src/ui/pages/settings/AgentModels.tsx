/**
 * Settings → Agent models (D17): every registry prompt key (`GET /api/ai/agent-models`) with what
 * would answer it right now — provider, model and a source badge (`assignment | tenant | platform |
 * none`) computed by the server's own planner. "Override" opens a modal: pick an existing chat
 * config (or keep the default one) and/or type a model; `PUT` sends only what is set. "Use default"
 * is a `DELETE` — absence is the default, never a sentinel. Members (`read AiConfig`) see the
 * table read-only; the tab itself is shown to `manage AiConfig` holders.
 */

import { CpuChipIcon } from '@heroicons/react/24/outline'
import {
  type AgentModelEntry,
  type AgentModelSource,
  upsertAgentModelRequestSchema,
} from '@rocketflare/shared/ai/agent-models'
import { type AiConfig, shortModelName } from '@rocketflare/shared/ai/config'
import { type FormEvent, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  EmptyState,
  FieldError,
  fieldErrorFor,
  Modal,
  SectionPanel,
  SkeletonRows,
} from '@/ui/components/shared'
import { useAgentModels, useDeleteAgentModel, useUpsertAgentModel } from '@/ui/hooks/useAgentModels'
import { configsForScope, useAiConfigs } from '@/ui/hooks/useAiConfig'
import { usePermissions } from '@/ui/hooks/usePermissions'

const SOURCE_LABELS: Record<AgentModelSource, string> = {
  assignment: 'agent',
  tenant: 'tenant',
  platform: 'platform',
  none: 'none',
}

const SOURCE_BADGE: Record<AgentModelSource, string> = {
  assignment: 'badge-primary',
  tenant: 'badge-success',
  platform: 'badge-info',
  none: 'badge-warning',
}

export default function AgentModelsSettings() {
  const { can } = usePermissions()
  const canManage = can('manage', 'AiConfig')
  const entries = useAgentModels()
  const configs = useAiConfigs()
  const remove = useDeleteAgentModel()
  const [editing, setEditing] = useState<AgentModelEntry | null>(null)

  const chatConfigs = configsForScope(configs.data?.items, 'chat')
  const items = entries.data?.items ?? []
  const configLabel = (id: string | undefined) =>
    chatConfigs.find(c => c.id === id)?.label ?? (id ? id.slice(0, 8) : undefined)

  return (
    <SectionPanel
      flush
      title="Agent models"
      description="Point an individual agent or feature at a specific chat provider and model. Anything left on the default follows the workspace's default chat provider."
    >
      {entries.isLoading || configs.isLoading ? (
        <div className="px-5 pb-5">
          <SkeletonRows rows={3} />
        </div>
      ) : entries.isError ? (
        <p className="px-5 pb-5 text-sm text-error" role="alert">
          Agent models could not be loaded.
        </p>
      ) : items.length === 0 ? (
        <EmptyState icon={CpuChipIcon} size="sm" message="No prompts registered" />
      ) : (
        <>
          {chatConfigs.length === 0 && (
            <div className="mx-5 mb-3 alert alert-warning text-sm">
              <span>
                No chat provider is configured for this workspace, so every agent falls back to the
                platform default (if any).{' '}
                {canManage && (
                  <Link to="/settings?tab=ai" className="link">
                    Add one in the AI tab
                  </Link>
                )}
              </span>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="data-table" aria-label="Agent models">
              <thead>
                <tr>
                  <th>Agent / feature</th>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>Source</th>
                  {canManage && <th className="text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {items.map(entry => (
                  <tr key={entry.promptKey} data-prompt-key={entry.promptKey}>
                    <td>
                      <div className="font-medium">{entry.title}</div>
                      <code className="text-xs text-muted">{entry.promptKey}</code>
                    </td>
                    <td className="text-secondary">
                      {entry.effective.provider ?? <span className="text-muted">—</span>}
                      {entry.effective.configId && (
                        <span className="text-muted text-xs">
                          {' '}
                          · {configLabel(entry.effective.configId)}
                        </span>
                      )}
                    </td>
                    <td className="font-mono text-xs" title={entry.effective.model}>
                      {entry.effective.model ? (
                        shortModelName(entry.effective.model)
                      ) : (
                        <span className="text-muted font-sans">not configured</span>
                      )}
                    </td>
                    <td>
                      <span
                        className={`badge badge-sm ${SOURCE_BADGE[entry.effective.source]}`}
                        title={
                          entry.effective.source === 'assignment'
                            ? 'Pinned for this agent'
                            : entry.effective.source === 'tenant'
                              ? "The workspace's default chat provider"
                              : entry.effective.source === 'platform'
                                ? 'The platform default'
                                : 'Nothing answers this agent'
                        }
                      >
                        {SOURCE_LABELS[entry.effective.source]}
                      </span>
                    </td>
                    {canManage && (
                      <td className="text-right whitespace-nowrap">
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          onClick={() => setEditing(entry)}
                          aria-label={`Override ${entry.title}`}
                        >
                          {entry.assignment ? 'Edit override' : 'Override'}
                        </button>
                        {entry.assignment && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            onClick={() => remove.mutate(entry.promptKey)}
                            disabled={remove.isPending}
                            aria-label={`Use default for ${entry.title}`}
                          >
                            Use default
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {entries.data?.items.every(e => e.effective.source === 'none') && (
            <div className="px-5 py-4">
              <EmptyState
                icon={CpuChipIcon}
                size="sm"
                message="Nothing answers agents yet"
                description="Add a chat provider and the agents follow it."
                action={
                  canManage ? (
                    <Link to="/settings?tab=ai" className="btn btn-primary btn-sm">
                      Open the AI tab
                    </Link>
                  ) : undefined
                }
              />
            </div>
          )}
        </>
      )}

      {editing && (
        <OverrideModal entry={editing} configs={chatConfigs} onClose={() => setEditing(null)} />
      )}
    </SectionPanel>
  )
}

/** Sentinel `<select>` value for "keep the default chat config"; a uuid can never collide. */
const DEFAULT_CONFIG = ''

function OverrideModal({
  entry,
  configs,
  onClose,
}: {
  entry: AgentModelEntry
  configs: AiConfig[]
  onClose: () => void
}) {
  const upsert = useUpsertAgentModel()
  const [configId, setConfigId] = useState(entry.assignment?.aiConfigId ?? DEFAULT_CONFIG)
  const [model, setModel] = useState(entry.assignment?.model ?? '')
  const [issues, setIssues] = useState<{ path: PropertyKey[]; message: string }[]>()

  const chosen = configs.find(c => c.id === configId)
  const defaultConfig = configs.find(c => c.isDefault)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const candidate = {
      ...(configId ? { aiConfigId: configId } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
    }
    const parsed = upsertAgentModelRequestSchema.safeParse(candidate)
    if (!parsed.success) return setIssues(parsed.error.issues)
    setIssues(undefined)
    upsert.mutate({ promptKey: entry.promptKey, ...parsed.data }, { onSuccess: onClose })
  }

  const rootIssue = issues?.find(i => i.path.length === 0)?.message

  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          Override model
          <code className="text-xs text-muted font-normal">{entry.promptKey}</code>
        </span>
      }
      actions={
        <>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="agent-model-form"
            className="btn btn-sm btn-primary"
            disabled={upsert.isPending}
          >
            {upsert.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="agent-model-form" onSubmit={submit} className="space-y-3" noValidate>
        <p className="text-sm text-secondary">
          {entry.title} currently runs on{' '}
          {entry.effective.model ? (
            <span className="font-mono text-xs">{shortModelName(entry.effective.model)}</span>
          ) : (
            'nothing'
          )}
          . Pick a chat provider entry, a model, or both.
        </p>
        <div>
          <label htmlFor="agent-model-config" className="label text-sm font-medium">
            Chat provider
          </label>
          <select
            id="agent-model-config"
            className="select select-sm w-full"
            value={configId}
            onChange={e => setConfigId(e.target.value)}
          >
            <option value={DEFAULT_CONFIG}>
              Default
              {defaultConfig
                ? ` (${defaultConfig.label} · ${shortModelName(defaultConfig.model)})`
                : ''}
            </option>
            {configs.map(config => (
              <option key={config.id} value={config.id}>
                {config.label} · {config.provider} · {shortModelName(config.model)}
              </option>
            ))}
          </select>
          <FieldError message={fieldErrorFor(issues, 'aiConfigId')} />
        </div>
        <div>
          <label htmlFor="agent-model-model" className="label text-sm font-medium">
            Model <span className="text-muted font-normal">(optional)</span>
          </label>
          <input
            id="agent-model-model"
            className="input input-sm w-full font-mono"
            placeholder={chosen?.model ?? defaultConfig?.model ?? 'model id'}
            value={model}
            maxLength={255}
            onChange={e => setModel(e.target.value)}
          />
          <FieldError message={fieldErrorFor(issues, 'model')} />
          <p className="text-xs text-muted mt-1">
            Leave blank to use the provider entry's own model. Any id the provider serves is
            accepted — it is not checked here.
          </p>
        </div>
        <FieldError message={rootIssue} />
      </form>
    </Modal>
  )
}
