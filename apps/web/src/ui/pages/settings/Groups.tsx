/**
 * Settings → Groups (D29). Group TYPES on the left, that type's groups on the right, and a modal
 * for who is in a group. `manage Group` (admin+) throughout — the tab does not render at all
 * otherwise, because a picker or a table you cannot save from is worse than no tab.
 *
 * Deleting a type or a group that still controls access answers 409 `group_in_use` with the
 * counts; the confirm dialog quotes them and says what forcing it does, because "delete" here
 * changes who can see content and the user should not discover that afterwards.
 */
import { PlusIcon, TrashIcon, UserGroupIcon, UsersIcon } from '@heroicons/react/24/outline'
import type { Group, GroupType } from '@rocketflare/shared/groups'
import { useState } from 'react'
import {
  ConfirmModal,
  EmptyState,
  SectionPanel,
  SkeletonRows,
  showToast,
} from '@/ui/components/shared'
import {
  useCreateGroup,
  useCreateGroupType,
  useDeleteGroup,
  useDeleteGroupType,
  useGroups,
  useGroupTypes,
} from '@/ui/hooks/useGroups'
import { ApiError } from '@/ui/lib/api-client'
import { GroupMembersModal } from './GroupMembersModal'

/** The 409 body: how much content the delete is about to narrow. */
interface InUse {
  documents: number
  dashboards: number
}

function inUseFrom(err: unknown): InUse | null {
  if (!(err instanceof ApiError) || err.code !== 'group_in_use') return null
  const details = err.details as Partial<InUse> | undefined
  return { documents: details?.documents ?? 0, dashboards: details?.dashboards ?? 0 }
}

export default function GroupsSettings() {
  const types = useGroupTypes()
  const [selectedTypeId, setSelectedTypeId] = useState<string | null>(null)
  const items = types.data?.items ?? []
  const activeTypeId =
    selectedTypeId && items.some(t => t.id === selectedTypeId)
      ? selectedTypeId
      : (items[0]?.id ?? null)

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <GroupTypesPanel
        types={items}
        isLoading={types.isLoading}
        activeTypeId={activeTypeId}
        onSelect={setSelectedTypeId}
      />
      <GroupsPanel type={items.find(t => t.id === activeTypeId) ?? null} />
    </div>
  )
}

function GroupTypesPanel({
  types,
  isLoading,
  activeTypeId,
  onSelect,
}: {
  types: GroupType[]
  isLoading: boolean
  activeTypeId: string | null
  onSelect: (id: string) => void
}) {
  const [name, setName] = useState('')
  const create = useCreateGroupType()
  const remove = useDeleteGroupType()
  const [deleting, setDeleting] = useState<GroupType | null>(null)
  const [inUse, setInUse] = useState<InUse | null>(null)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    create.mutate(
      { name: trimmed },
      {
        onSuccess: created => {
          setName('')
          onSelect(created.id)
        },
      }
    )
  }

  const confirmDelete = () => {
    if (!deleting) return
    remove.mutate(
      { id: deleting.id, force: inUse !== null },
      {
        onSuccess: () => {
          showToast(`Deleted “${deleting.name}”`, 'success')
          setDeleting(null)
          setInUse(null)
        },
        onError: err => {
          const found = inUseFrom(err)
          if (found) setInUse(found)
          else setDeleting(null)
        },
      }
    )
  }

  return (
    <SectionPanel title="Group types" description="Department, Region, Client…">
      {isLoading ? (
        <SkeletonRows rows={3} />
      ) : types.length === 0 ? (
        <EmptyState
          icon={UserGroupIcon}
          size="sm"
          message="No group types yet"
          description="Create one, such as Department."
        />
      ) : (
        <ul className="menu menu-sm p-0 gap-0.5" aria-label="Group types">
          {types.map(type => (
            <li key={type.id}>
              <button
                type="button"
                className={`justify-between ${type.id === activeTypeId ? 'active' : ''}`}
                onClick={() => onSelect(type.id)}
              >
                <span className="truncate">{type.name}</span>
                <span className="flex items-center gap-2">
                  <span className="badge badge-sm badge-ghost">{type.groupCount}</span>
                  <TrashIcon
                    className="w-4 h-4 opacity-60 hover:opacity-100"
                    role="button"
                    aria-label={`Delete ${type.name}`}
                    onClick={event => {
                      event.stopPropagation()
                      setInUse(null)
                      setDeleting(type)
                    }}
                  />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={submit} className="mt-4 flex gap-2">
        <input
          className="input input-sm input-bordered flex-1"
          placeholder="New type"
          aria-label="New group type"
          value={name}
          onChange={e => setName(e.target.value)}
        />
        <button type="submit" className="btn btn-sm btn-primary" disabled={create.isPending}>
          <PlusIcon className="w-4 h-4" />
          Add
        </button>
      </form>

      <ConfirmModal
        isOpen={Boolean(deleting)}
        title={`Delete “${deleting?.name}”?`}
        message={
          inUse
            ? `This type still controls access to ${inUse.documents} document(s) and ${inUse.dashboards} dashboard(s). Deleting it leaves them visible to their owner and to administrators only — never to everyone.`
            : 'Its groups and their memberships go with it.'
        }
        confirmText={inUse ? 'Delete anyway' : 'Delete'}
        confirmButtonClass="btn-error"
        onConfirm={confirmDelete}
        onCancel={() => {
          setDeleting(null)
          setInUse(null)
        }}
      />
    </SectionPanel>
  )
}

function GroupsPanel({ type }: { type: GroupType | null }) {
  const { data, isLoading } = useGroups(type?.id, Boolean(type))
  const create = useCreateGroup()
  const remove = useDeleteGroup()
  const [name, setName] = useState('')
  const [open, setOpen] = useState<Group | null>(null)
  const [deleting, setDeleting] = useState<Group | null>(null)
  const [inUse, setInUse] = useState<InUse | null>(null)

  if (!type) {
    return (
      <SectionPanel title="Groups">
        <EmptyState
          icon={UserGroupIcon}
          message="Create a group type first"
          description="A group type such as Department holds the groups people belong to."
        />
      </SectionPanel>
    )
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    create.mutate({ groupTypeId: type.id, name: trimmed }, { onSuccess: () => setName('') })
  }

  const confirmDelete = () => {
    if (!deleting) return
    remove.mutate(
      { id: deleting.id, force: inUse !== null },
      {
        onSuccess: () => {
          showToast(`Deleted “${deleting.name}”`, 'success')
          setDeleting(null)
          setInUse(null)
        },
        onError: err => {
          const found = inUseFrom(err)
          if (found) setInUse(found)
          else setDeleting(null)
        },
      }
    )
  }

  const groups = data?.items ?? []

  return (
    <SectionPanel
      flush
      title={type.name}
      description={`${groups.length} ${groups.length === 1 ? 'group' : 'groups'}`}
    >
      {isLoading ? (
        <div className="p-5">
          <SkeletonRows rows={3} />
        </div>
      ) : groups.length === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={UsersIcon}
            size="sm"
            message={`No groups in ${type.name} yet`}
            description="Add one below, then put people in it."
          />
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>People</th>
              <th className="w-px" />
            </tr>
          </thead>
          <tbody>
            {groups.map(group => (
              <tr key={group.id}>
                <td className="font-medium">{group.name}</td>
                <td>{group.memberCount}</td>
                <td className="whitespace-nowrap text-right">
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    onClick={() => setOpen(group)}
                  >
                    Members
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs text-error"
                    aria-label={`Delete ${group.name}`}
                    onClick={() => {
                      setInUse(null)
                      setDeleting(group)
                    }}
                  >
                    <TrashIcon className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form onSubmit={submit} className="flex gap-2 p-5 pt-4">
        <input
          className="input input-sm input-bordered flex-1"
          placeholder={`New group in ${type.name}`}
          aria-label="New group"
          value={name}
          onChange={e => setName(e.target.value)}
        />
        <button type="submit" className="btn btn-sm btn-primary" disabled={create.isPending}>
          <PlusIcon className="w-4 h-4" />
          Add
        </button>
      </form>

      <GroupMembersModal group={open} onClose={() => setOpen(null)} />

      <ConfirmModal
        isOpen={Boolean(deleting)}
        title={`Delete “${deleting?.name}”?`}
        message={
          inUse
            ? `This group still controls access to ${inUse.documents} document(s) and ${inUse.dashboards} dashboard(s). Deleting it leaves them visible to their owner and to administrators only — never to everyone.`
            : 'Its memberships go with it.'
        }
        confirmText={inUse ? 'Delete anyway' : 'Delete'}
        confirmButtonClass="btn-error"
        onConfirm={confirmDelete}
        onCancel={() => {
          setDeleting(null)
          setInUse(null)
        }}
      />
    </SectionPanel>
  )
}
