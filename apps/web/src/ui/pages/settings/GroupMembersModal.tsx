/**
 * Who is in one group (D29): the current members with a remove, and a searchable picker over the
 * tenant's people to add several at once. Adding is idempotent server-side, so a double-click or a
 * name already in the group costs nothing.
 */
import { MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/outline'
import type { Group } from '@rocketflare/shared/groups'
import { useMemo, useState } from 'react'
import { EmptyState, Modal, SkeletonRows, showToast } from '@/ui/components/shared'
import { useAddGroupMembers, useGroup, useRemoveGroupMember } from '@/ui/hooks/useGroups'
import { useMembers } from '@/ui/hooks/useMembers'

export function GroupMembersModal({
  group,
  onClose,
}: {
  group: Group | null
  onClose: () => void
}) {
  const detail = useGroup(group?.id ?? null)
  // One page of people is enough for the picker; a big organisation searches rather than scrolls.
  const members = useMembers({ page: 1, pageSize: 100 })
  const add = useAddGroupMembers()
  const remove = useRemoveGroupMember()
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string[]>([])

  const inGroup = useMemo(
    () => new Set((detail.data?.members ?? []).map(m => m.userId)),
    [detail.data]
  )
  const candidates = (members.data?.items ?? []).filter(m => {
    if (inGroup.has(m.userId)) return false
    const needle = query.trim().toLowerCase()
    return (
      !needle || m.name.toLowerCase().includes(needle) || m.email.toLowerCase().includes(needle)
    )
  })

  const close = () => {
    setQuery('')
    setPicked([])
    onClose()
  }

  const addPicked = () => {
    if (!group || picked.length === 0) return
    add.mutate(
      { id: group.id, userIds: picked },
      {
        onSuccess: () => {
          showToast(
            `Added ${picked.length} ${picked.length === 1 ? 'person' : 'people'} to ${group.name}`,
            'success'
          )
          setPicked([])
          setQuery('')
        },
      }
    )
  }

  return (
    <Modal
      open={Boolean(group)}
      onClose={close}
      title={group ? `${group.name} · ${group.typeName}` : ''}
      className="max-w-2xl"
      actions={
        <button type="button" className="btn btn-sm" onClick={close}>
          Done
        </button>
      }
    >
      <div className="space-y-5">
        <section>
          <h3 className="text-sm font-medium mb-2">In this group</h3>
          {detail.isLoading ? (
            <SkeletonRows rows={2} />
          ) : (detail.data?.members ?? []).length === 0 ? (
            <EmptyState size="sm" message="Nobody yet" description="Add people below." />
          ) : (
            <ul className="divide-y divide-[color:var(--border-subtle)]">
              {(detail.data?.members ?? []).map(member => (
                <li key={member.userId} className="flex items-center justify-between py-2">
                  <span className="min-w-0">
                    <span className="block text-sm truncate">{member.name}</span>
                    <span className="block text-xs text-muted truncate">{member.email}</span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    aria-label={`Remove ${member.name}`}
                    disabled={remove.isPending}
                    onClick={() => group && remove.mutate({ id: group.id, userId: member.userId })}
                  >
                    <XMarkIcon className="w-4 h-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3 className="text-sm font-medium mb-2">Add people</h3>
          <label className="input input-sm input-bordered flex items-center gap-2">
            <MagnifyingGlassIcon className="w-4 h-4 opacity-60" />
            <input
              className="grow"
              placeholder="Search by name or email"
              aria-label="Search people"
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
          </label>
          <ul className="mt-2 max-h-56 overflow-y-auto divide-y divide-[color:var(--border-subtle)]">
            {candidates.map(person => (
              <li key={person.userId}>
                <label className="flex items-center gap-2 py-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-sm"
                    checked={picked.includes(person.userId)}
                    onChange={e =>
                      setPicked(current =>
                        e.target.checked
                          ? [...current, person.userId]
                          : current.filter(id => id !== person.userId)
                      )
                    }
                  />
                  <span className="min-w-0">
                    <span className="block text-sm truncate">{person.name}</span>
                    <span className="block text-xs text-muted truncate">{person.email}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn btn-sm btn-primary mt-3"
            disabled={picked.length === 0 || add.isPending}
            onClick={addPicked}
          >
            Add {picked.length > 0 ? picked.length : ''}
          </button>
        </section>
      </div>
    </Modal>
  )
}
