/**
 * Your memory (D36): what the assistant has learned from your chats in this organisation — each
 * fact with when you said it and, when known, when it happened — and the controls a person needs
 * to trust it: switch it off, forget one fact, forget everything. Mounted by the Profile page only
 * when the organisation has the `memory` flag (`session.features`); the routes are 404 otherwise.
 *
 * Nobody else sees this list. A private memory is not readable by admins either, which is why
 * this lives on YOUR account page rather than under Settings.
 */
import type { Memory } from '@rocketflare/shared/ai/memory'
import { useState } from 'react'
import {
  ConfirmModal,
  PaginationControls,
  SectionPanel,
  SkeletonRows,
} from '@/ui/components/shared'
import { useDebounce } from '@/ui/hooks/useDebounce'
import {
  useForgetAllMemories,
  useForgetMemory,
  useMemories,
  useMemorySettings,
  useUpdateMemorySettings,
} from '@/ui/hooks/useMemory'
import { formatDate } from '@/ui/lib/format'

/** "Mar 2026", "Mar 1 – Mar 31, 2026" — when what a fact describes happened, if it is known. */
export function occurredLabel(
  memory: Pick<Memory, 'occurredStart' | 'occurredEnd'>
): string | null {
  if (!memory.occurredStart) return null
  const start = formatDate(memory.occurredStart)
  if (!memory.occurredEnd) return `since ${start}`
  const end = formatDate(memory.occurredEnd)
  return start === end ? start : `${start} – ${end}`
}

export default function ProfileMemory() {
  const settings = useMemorySettings()
  const update = useUpdateMemorySettings()
  const forgetAll = useForgetAllMemories()
  const forget = useForgetMemory()
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [history, setHistory] = useState(false)
  const [confirmAll, setConfirmAll] = useState(false)
  const q = useDebounce(search.trim(), 300)
  const { data, isLoading, isFetching } = useMemories({
    page,
    pageSize: 20,
    q: q || undefined,
    includeHistorical: history,
  })
  const enabled = settings.data?.enabled ?? true
  const items = data?.items ?? []

  return (
    <SectionPanel
      title="Memory"
      description="Facts the assistant has learned from what you told it in chat, so it can recall them in later conversations. Only you can see them."
      actions={
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="toggle toggle-sm toggle-primary"
            checked={enabled}
            disabled={settings.isLoading || update.isPending}
            onChange={e => update.mutate(e.target.checked)}
            aria-label="Remember things I tell the assistant"
          />
          {enabled ? 'On' : 'Off'}
        </label>
      }
    >
      {!enabled && (
        <p className="text-sm text-secondary mb-3">
          Memory is off. Nothing you say in chat is learned while it is off — switching it back on
          does not reach back into those conversations.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <input
          type="search"
          className="input input-sm input-bordered flex-1 min-w-48"
          placeholder="Search your memory"
          value={search}
          onChange={e => {
            setSearch(e.target.value)
            setPage(1)
          }}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="checkbox checkbox-sm"
            checked={history}
            onChange={e => {
              setHistory(e.target.checked)
              setPage(1)
            }}
          />
          Include replaced facts
        </label>
        <button
          type="button"
          className="btn btn-ghost btn-sm text-error"
          disabled={items.length === 0}
          onClick={() => setConfirmAll(true)}
        >
          Forget everything
        </button>
      </div>

      {isLoading ? (
        <SkeletonRows rows={3} />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted py-3">
          {q ? 'Nothing in your memory matches that.' : 'Nothing remembered yet.'}
        </p>
      ) : (
        <ul className="divide-y divide-[color:var(--border-subtle)]">
          {items.map(memory => {
            const when = occurredLabel(memory)
            return (
              <li key={memory.id} className="flex items-start gap-3 py-3">
                <div className="flex-1 min-w-0">
                  <p className={`text-sm ${memory.invalidatedAt ? 'line-through text-muted' : ''}`}>
                    {memory.text}
                  </p>
                  <p className="text-xs text-muted mt-1 flex flex-wrap gap-x-3">
                    <span>Said {formatDate(memory.mentionedAt)}</span>
                    {when && <span>About {when}</span>}
                    {memory.invalidatedAt && (
                      <span>Replaced {formatDate(memory.invalidatedAt)}</span>
                    )}
                    {memory.entities.length > 0 && (
                      <span>{memory.entities.map(e => e.name).join(' · ')}</span>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  disabled={forget.isPending}
                  onClick={() => forget.mutate(memory.id)}
                  aria-label={`Forget "${memory.text}"`}
                >
                  Forget
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {data && (
        <PaginationControls
          pagination={data.pagination}
          onPageChange={setPage}
          isLoading={isFetching}
          className="mt-3"
        />
      )}

      <ConfirmModal
        isOpen={confirmAll}
        title="Forget everything"
        message="Delete everything the assistant has learned from your chats in this organisation? This cannot be undone."
        confirmText="Forget everything"
        confirmButtonClass="btn-error"
        isLoading={forgetAll.isPending}
        onCancel={() => setConfirmAll(false)}
        onConfirm={() => forgetAll.mutate(undefined, { onSuccess: () => setConfirmAll(false) })}
      />
    </SectionPanel>
  )
}
