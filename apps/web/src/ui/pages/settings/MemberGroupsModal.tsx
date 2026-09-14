/**
 * One person's groups, edited from the People page (D29): checkboxes grouped by type, saved as a
 * whole set (`PUT /api/members/:userId/groups`). Editing from the person rather than from the
 * group is what makes "this new starter belongs in Finance and EMEA" one dialog.
 */
import type { Member } from '@rocketflare/shared/tenants'
import { useEffect, useState } from 'react'
import { EmptyState, Modal, SkeletonRows, showToast } from '@/ui/components/shared'
import { useGroups, useSetMemberGroups } from '@/ui/hooks/useGroups'

export function MemberGroupsModal({
  member,
  onClose,
}: {
  member: Member | null
  onClose: () => void
}) {
  const { data, isLoading } = useGroups(undefined, Boolean(member))
  const save = useSetMemberGroups()
  const [selected, setSelected] = useState<string[]>([])

  // Re-seed whenever a different person is opened; the member row carries their groups already.
  useEffect(() => {
    setSelected((member?.groups ?? []).map(g => g.id))
  }, [member])

  const groups = data?.items ?? []
  const byType = groups.reduce<Record<string, typeof groups>>((acc, group) => {
    acc[group.typeName] = [...(acc[group.typeName] ?? []), group]
    return acc
  }, {})

  const submit = () => {
    if (!member) return
    save.mutate(
      { userId: member.userId, groupIds: selected },
      {
        onSuccess: () => {
          showToast(`Updated ${member.name}'s groups`, 'success')
          onClose()
        },
      }
    )
  }

  return (
    <Modal
      open={Boolean(member)}
      onClose={onClose}
      title={member ? `Groups for ${member.name}` : ''}
      actions={
        <>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={save.isPending}
            onClick={submit}
          >
            Save
          </button>
        </>
      }
    >
      {isLoading ? (
        <SkeletonRows rows={3} />
      ) : groups.length === 0 ? (
        <EmptyState
          size="sm"
          message="No groups yet"
          description="Create a group type and a group on the Groups tab first."
        />
      ) : (
        <div className="space-y-4">
          {Object.entries(byType).map(([typeName, list]) => (
            <fieldset key={typeName}>
              <legend className="text-xs uppercase tracking-wide text-muted mb-1">
                {typeName}
              </legend>
              <div className="space-y-1">
                {list.map(group => (
                  <label key={group.id} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      className="checkbox checkbox-sm"
                      checked={selected.includes(group.id)}
                      onChange={e =>
                        setSelected(current =>
                          e.target.checked
                            ? [...current, group.id]
                            : current.filter(id => id !== group.id)
                        )
                      }
                    />
                    <span className="text-sm">{group.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      )}
    </Modal>
  )
}
