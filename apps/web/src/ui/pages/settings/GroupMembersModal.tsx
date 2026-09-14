/**
 * Who is in one group (D29). Two columns, because the task is a comparison: everyone in the
 * organisation on the left with a search and a checkbox, the group's current members on the right.
 * The single stacked list this replaced made "who is NOT in this group yet" something you worked
 * out by scrolling between two lists that looked the same.
 *
 * The left column lists only people who are NOT in the group yet. Marking them instead was tried
 * and is worse: in a group that holds most of the organisation the column becomes a wall of greyed
 * rows with nothing to do in it, and "who is in this group" is already answered — in full, on the
 * right. Adding is idempotent server-side, so a double-click costs nothing.
 */
import { MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/outline'
import type { Group } from '@rocketflare/shared/groups'
import type { Member } from '@rocketflare/shared/tenants'
import { useMemo, useState } from 'react'
import { EmptyState, Modal, SkeletonRows, showToast } from '@/ui/components/shared'
import { useAddGroupMembers, useGroup, useRemoveGroupMember } from '@/ui/hooks/useGroups'
import { useMembers } from '@/ui/hooks/useMembers'
import { initials } from '@/ui/lib/format'

/** One page of people is enough to choose from; a big organisation searches rather than scrolls. */
const PEOPLE_PAGE_SIZE = 100

export function GroupMembersModal({
  group,
  onClose,
}: {
  group: Group | null
  onClose: () => void
}) {
  const detail = useGroup(group?.id ?? null)
  const people = useMembers({ page: 1, pageSize: PEOPLE_PAGE_SIZE })
  const add = useAddGroupMembers()
  const remove = useRemoveGroupMember()
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string[]>([])

  const members = detail.data?.members ?? []
  const inGroup = useMemo(() => new Set(members.map(m => m.userId)), [members])

  const needle = query.trim().toLowerCase()
  const available = (people.data?.items ?? []).filter(p => !inGroup.has(p.userId))
  const candidates = available.filter(
    p => !needle || p.name.toLowerCase().includes(needle) || p.email.toLowerCase().includes(needle)
  )
  const everyoneIsIn = available.length === 0 && (people.data?.items ?? []).length > 0

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
      title={
        group ? (
          <span className="flex items-baseline gap-2">
            <span>{group.name}</span>
            <span className="text-sm font-normal text-muted">{group.typeName}</span>
          </span>
        ) : (
          ''
        )
      }
      className="max-w-3xl"
      actions={
        <button type="button" className="btn btn-sm" onClick={close}>
          Done
        </button>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        {/* Left: who could still be added, searchable. */}
        <section className="flex flex-col min-h-0">
          <header className="mb-2">
            <h3 className="text-sm font-medium">Add people</h3>
            <p className="text-xs text-muted">
              {people.data
                ? `${available.length} ${available.length === 1 ? 'person' : 'people'} not in this group`
                : ' '}
            </p>
          </header>
          {/* `w-full` so the search box lines up with the list beneath it — a narrower input
              reads as a different column. */}
          <label className="input input-sm input-bordered flex w-full items-center gap-2">
            <MagnifyingGlassIcon className="w-4 h-4 opacity-60" aria-hidden="true" />
            <input
              className="grow"
              placeholder="Search by name or email"
              aria-label="Search people"
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
          </label>

          <ul className="mt-2 flex-1 max-h-72 overflow-y-auto rounded-box border border-[color:var(--border-subtle)] divide-y divide-[color:var(--border-subtle)]">
            {people.isLoading ? (
              <li className="p-3">
                <SkeletonRows rows={3} />
              </li>
            ) : candidates.length === 0 ? (
              <li className="p-3">
                <EmptyState
                  size="sm"
                  message={
                    everyoneIsIn
                      ? 'Everyone is already in this group'
                      : 'Nobody matches that search'
                  }
                />
              </li>
            ) : (
              candidates.map(person => (
                <li key={person.userId}>
                  <PersonRow
                    person={person}
                    checked={picked.includes(person.userId)}
                    onToggle={checked =>
                      setPicked(current =>
                        checked
                          ? [...current, person.userId]
                          : current.filter(id => id !== person.userId)
                      )
                    }
                  />
                </li>
              ))
            )}
          </ul>

          <button
            type="button"
            className="btn btn-sm btn-primary mt-3 self-start"
            disabled={picked.length === 0 || add.isPending}
            onClick={addPicked}
          >
            {picked.length > 0 ? `Add ${picked.length}` : 'Add'}
          </button>
        </section>

        {/* Right: who is in the group now. */}
        <section className="flex flex-col min-h-0">
          <header className="mb-2">
            <h3 className="text-sm font-medium">In this group</h3>
            <p className="text-xs text-muted">
              {members.length} {members.length === 1 ? 'person' : 'people'}
            </p>
          </header>
          <ul className="flex-1 max-h-[22.5rem] overflow-y-auto rounded-box border border-[color:var(--border-subtle)] divide-y divide-[color:var(--border-subtle)]">
            {detail.isLoading ? (
              <li className="p-3">
                <SkeletonRows rows={2} />
              </li>
            ) : members.length === 0 ? (
              <li className="p-3">
                <EmptyState
                  size="sm"
                  message="Nobody yet"
                  description="Pick people on the left, then Add."
                />
              </li>
            ) : (
              members.map(member => (
                <li key={member.userId} className="flex items-center gap-3 px-3 py-2">
                  <Initials name={member.name} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm truncate">{member.name}</span>
                    <span className="block text-xs text-muted truncate">{member.email}</span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs btn-square"
                    aria-label={`Remove ${member.name}`}
                    disabled={remove.isPending}
                    onClick={() => group && remove.mutate({ id: group.id, userId: member.userId })}
                  >
                    <XMarkIcon className="w-4 h-4" />
                  </button>
                </li>
              ))
            )}
          </ul>
        </section>
      </div>
    </Modal>
  )
}

function PersonRow({
  person,
  checked,
  onToggle,
}: {
  person: Member
  checked: boolean
  onToggle: (checked: boolean) => void
}) {
  return (
    <label className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-base-200">
      <input
        type="checkbox"
        className="checkbox checkbox-sm"
        checked={checked}
        onChange={e => onToggle(e.target.checked)}
      />
      <Initials name={person.name} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm truncate">{person.name}</span>
        <span className="block text-xs text-muted truncate">{person.email}</span>
      </span>
    </label>
  )
}

/** A quiet avatar stand-in: the member row carries a URL, but a tenant-scoped object 404s often
 *  enough that initials are the honest default here. */
function Initials({ name }: { name: string }) {
  return (
    <span
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-base-300 text-[0.65rem] font-medium"
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  )
}
