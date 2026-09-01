/**
 * Settings → AI (D17): readiness for `chat` and `embeddings` (what the resolver WOULD pick, with
 * its source), then one table per scope — label, provider, model, default and credential badges,
 * and for `manage AiConfig` holders: set default, test, edit, delete. Members (`read`) see the
 * readiness and a read-only list. Credentials never reach the browser (`hasCredential` only).
 */

import { PlusIcon, SparklesIcon } from '@heroicons/react/24/outline'
import {
  type AiConfig,
  type AiScope,
  type AiScopeReadiness,
  shortModelName,
  type TestAiConfigResponse,
} from '@rocketflare/shared/ai/config'
import { useState } from 'react'
import {
  ConfirmModal,
  EmptyState,
  SectionPanel,
  SectionPanelSkeleton,
  SkeletonRows,
} from '@/ui/components/shared'
import {
  type AiProviderInfo,
  configsForScope,
  useAiConfigs,
  useAiProviders,
  useAiReadiness,
  useDeleteAiConfig,
  useTestAiConfig,
  useUpsertAiConfig,
} from '@/ui/hooks/useAiConfig'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { AiConfigModal, TestVerdict } from './AiConfigModal'

const SCOPES: { scope: AiScope; title: string; description: string }[] = [
  {
    scope: 'chat',
    title: 'Chat providers',
    description: 'Answer conversations and run agents. One entry is the default.',
  },
  {
    scope: 'embeddings',
    title: 'Embedding providers',
    description: 'Turn text into vectors for search. Workers AI needs no key.',
  },
]

type ModalTarget = { scope: AiScope; editing: AiConfig | null } | null

export default function AiSettings() {
  const { can } = usePermissions()
  const canManage = can('manage', 'AiConfig')
  const readiness = useAiReadiness()
  const configs = useAiConfigs()
  const providers = useAiProviders()
  const [modal, setModal] = useState<ModalTarget>(null)

  const providerName = (id: string) => providers.data?.items.find(p => p.id === id)?.name ?? id

  return (
    <div className="space-y-6">
      <SectionPanel
        title="Readiness"
        description="What answers this workspace right now, and where that comes from."
      >
        {readiness.isLoading ? (
          <SkeletonRows rows={2} />
        ) : readiness.data ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <ReadinessCard
              scope="chat"
              readiness={readiness.data.chat}
              providerName={providerName}
              canManage={canManage}
              onConfigure={() => setModal({ scope: 'chat', editing: null })}
            />
            <ReadinessCard
              scope="embeddings"
              readiness={readiness.data.embeddings}
              providerName={providerName}
              canManage={canManage}
              onConfigure={() => setModal({ scope: 'embeddings', editing: null })}
            />
          </div>
        ) : (
          <p className="text-sm text-error" role="alert">
            Readiness could not be loaded.
          </p>
        )}
      </SectionPanel>

      {configs.isLoading || providers.isLoading ? (
        <SectionPanelSkeleton rows={3} />
      ) : (
        SCOPES.map(({ scope, title, description }) => (
          <ScopeSection
            key={scope}
            scope={scope}
            title={title}
            description={description}
            rows={configsForScope(configs.data?.items, scope)}
            providers={providers.data?.items ?? []}
            canManage={canManage}
            onAdd={() => setModal({ scope, editing: null })}
            onEdit={row => setModal({ scope, editing: row })}
          />
        ))
      )}

      <AiConfigModal
        open={modal !== null}
        onClose={() => setModal(null)}
        scope={modal?.scope ?? 'chat'}
        providers={providers.data?.items ?? []}
        editing={modal?.editing ?? null}
        scopeHasDefault={configsForScope(configs.data?.items, modal?.scope ?? 'chat').some(
          c => c.isDefault
        )}
      />
    </div>
  )
}

function ReadinessCard({
  scope,
  readiness,
  providerName,
  canManage,
  onConfigure,
}: {
  scope: AiScope
  readiness: AiScopeReadiness
  providerName: (id: string) => string
  canManage: boolean
  onConfigure: () => void
}) {
  const title = scope === 'chat' ? 'Chat' : 'Embeddings'
  return (
    <div className="surface-inset rounded-lg p-3 flex flex-col gap-2" data-scope={scope}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        {readiness.ready ? (
          <span className="badge badge-success badge-sm">Ready</span>
        ) : (
          <span className="badge badge-warning badge-sm">Not configured</span>
        )}
      </div>
      {readiness.ready ? (
        <p className="text-xs text-secondary">
          {readiness.provider ? providerName(readiness.provider) : 'Provider'}
          {readiness.model && (
            <>
              {' · '}
              <span className="font-mono" title={readiness.model}>
                {shortModelName(readiness.model)}
              </span>
            </>
          )}
          {' · '}
          {readiness.source === 'tenant' ? 'this workspace' : 'platform default'}
        </p>
      ) : canManage ? (
        <button
          type="button"
          className="btn btn-primary btn-xs self-start gap-1"
          onClick={onConfigure}
        >
          <PlusIcon className="w-3.5 h-3.5" />
          Set up {title.toLowerCase()}
        </button>
      ) : (
        <p className="text-xs text-muted">Ask an administrator to add a provider.</p>
      )}
    </div>
  )
}

function ScopeSection({
  scope,
  title,
  description,
  rows,
  providers,
  canManage,
  onAdd,
  onEdit,
}: {
  scope: AiScope
  title: string
  description: string
  rows: AiConfig[]
  providers: AiProviderInfo[]
  canManage: boolean
  onAdd: () => void
  onEdit: (row: AiConfig) => void
}) {
  const upsert = useUpsertAiConfig()
  const remove = useDeleteAiConfig()
  const test = useTestAiConfig()
  const [deleting, setDeleting] = useState<AiConfig | null>(null)
  const [verdicts, setVerdicts] = useState<Record<string, TestAiConfigResponse>>({})
  const [testingId, setTestingId] = useState<string | null>(null)

  const providerName = (id: string) => providers.find(p => p.id === id)?.name ?? id

  const setDefault = (row: AiConfig) =>
    upsert.mutate({
      scope: row.scope,
      label: row.label,
      provider: row.provider,
      baseUrl: row.baseUrl ?? undefined,
      model: row.model,
      isDefault: true,
      thinking: row.thinking,
      serviceTier: row.serviceTier ?? '',
    })

  const runTest = (row: AiConfig) => {
    setTestingId(row.id)
    test.mutate(
      { configId: row.id },
      {
        onSuccess: result => setVerdicts(v => ({ ...v, [row.id]: result })),
        onSettled: () => setTestingId(null),
      }
    )
  }

  return (
    <SectionPanel
      flush
      title={title}
      description={description}
      actions={
        canManage && (
          <button type="button" className="btn btn-primary btn-sm gap-1.5" onClick={onAdd}>
            <PlusIcon className="w-4 h-4" />
            Add {scope === 'chat' ? 'chat' : 'embedding'} provider
          </button>
        )
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          icon={SparklesIcon}
          size="sm"
          message={`No ${scope} providers configured`}
          description={
            canManage
              ? 'The platform default answers until you add one.'
              : 'The platform default answers, if one is set.'
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table" aria-label={title}>
            <thead>
              <tr>
                <th>Label</th>
                <th>Provider</th>
                <th>Model</th>
                <th>Default</th>
                <th>Credential</th>
                {canManage && <th className="text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <RowGroup
                  key={row.id}
                  row={row}
                  providerName={providerName(row.provider)}
                  canManage={canManage}
                  verdict={verdicts[row.id]}
                  testing={testingId === row.id}
                  settingDefault={upsert.isPending}
                  onSetDefault={() => setDefault(row)}
                  onTest={() => runTest(row)}
                  onEdit={() => onEdit(row)}
                  onDelete={() => setDeleting(row)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmModal
        isOpen={deleting !== null}
        title="Remove AI provider"
        message={`Remove "${deleting?.label ?? ''}"? ${
          deleting?.isDefault
            ? 'It is the default — another entry (or the platform default) takes over.'
            : 'Consumers keep using the default.'
        }`}
        confirmText="Remove"
        confirmButtonClass="btn-error"
        isLoading={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })
        }}
      />
    </SectionPanel>
  )
}

function RowGroup({
  row,
  providerName,
  canManage,
  verdict,
  testing,
  settingDefault,
  onSetDefault,
  onTest,
  onEdit,
  onDelete,
}: {
  row: AiConfig
  providerName: string
  canManage: boolean
  verdict?: TestAiConfigResponse
  testing: boolean
  settingDefault: boolean
  onSetDefault: () => void
  onTest: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <>
      <tr>
        <td className="font-medium">{row.label}</td>
        <td className="text-secondary">{providerName}</td>
        <td className="font-mono text-xs" title={row.model}>
          {shortModelName(row.model)}
          {row.thinking.enabled && (
            <span className="badge badge-ghost badge-sm ml-1.5 font-sans">thinking</span>
          )}
        </td>
        <td>
          {row.isDefault ? (
            <span className="badge badge-primary badge-sm">default</span>
          ) : (
            <span className="text-muted text-xs">—</span>
          )}
        </td>
        <td>
          {row.hasCredential ? (
            <span className="badge badge-success badge-sm">key stored</span>
          ) : (
            <span className="badge badge-ghost badge-sm">no key</span>
          )}
        </td>
        {canManage && (
          <td className="text-right whitespace-nowrap">
            {!row.isDefault && (
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={onSetDefault}
                disabled={settingDefault}
              >
                Set default
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={onTest}
              disabled={testing}
              aria-label={`Test ${row.label}`}
            >
              {testing ? 'Testing…' : 'Test'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={onEdit}
              aria-label={`Edit ${row.label}`}
            >
              Edit
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-xs text-error"
              onClick={onDelete}
              aria-label={`Delete ${row.label}`}
            >
              Delete
            </button>
          </td>
        )}
      </tr>
      {verdict && (
        <tr>
          <td colSpan={canManage ? 6 : 5} className="py-1.5">
            <TestVerdict result={verdict} />
          </td>
        </tr>
      )}
    </>
  )
}
