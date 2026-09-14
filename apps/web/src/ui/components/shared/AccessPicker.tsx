/**
 * Who may read this (D29). A radio for "everyone in the organisation" or "only these groups", and
 * chips grouped by type for the second.
 *
 * Three decisions worth knowing about:
 *
 * - **It is only rendered for people who may CHANGE visibility.** A picker that 403s on save is
 *   worse than no picker, so the caller gates it rather than this component disabling itself.
 * - **An empty selection is legal and warned about**, not blocked: it is what somebody wants when
 *   they mean "just me and the admins", and it is what deleting a group leaves behind. Silently
 *   refusing it would hide the state the API can genuinely be in.
 * - A member is offered only the groups they belong to, because that is all the API will accept
 *   from them. The caller passes the right list; this component does not know the rules.
 */
import { LockClosedIcon } from '@heroicons/react/24/outline'
import type { GroupRef, ResourceVisibility } from '@rocketflare/shared/groups'

export interface AccessPickerProps {
  visibility: ResourceVisibility
  groupIds: string[]
  /** The groups this person may share with — every group for an admin, their own for a member. */
  available: GroupRef[]
  onChange: (next: { visibility: ResourceVisibility; groupIds: string[] }) => void
  /** The organisation's name, so the tenant-wide option reads as a place rather than a word. */
  tenantName?: string
  disabled?: boolean
  idPrefix?: string
}

/** `[{ typeName, groups }]` in the order the API returned them (type name, then group name). */
function byType(groups: GroupRef[]): { typeName: string; groups: GroupRef[] }[] {
  const out: { typeName: string; groups: GroupRef[] }[] = []
  for (const group of groups) {
    const bucket = out.find(b => b.typeName === group.typeName)
    if (bucket) bucket.groups.push(group)
    else out.push({ typeName: group.typeName, groups: [group] })
  }
  return out
}

export function AccessPicker({
  visibility,
  groupIds,
  available,
  onChange,
  tenantName,
  disabled = false,
  idPrefix = 'access',
}: AccessPickerProps) {
  const selected = new Set(groupIds)
  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange({ visibility: 'groups', groupIds: [...next] })
  }

  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="text-sm font-medium">Who can see this</legend>

      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="radio"
          name={`${idPrefix}-visibility`}
          className="radio radio-sm mt-0.5"
          checked={visibility === 'tenant'}
          onChange={() => onChange({ visibility: 'tenant', groupIds: [] })}
        />
        <span className="text-sm">
          Everyone in {tenantName ?? 'this organisation'}
          <span className="block text-xs text-muted">The default.</span>
        </span>
      </label>

      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="radio"
          name={`${idPrefix}-visibility`}
          className="radio radio-sm mt-0.5"
          checked={visibility === 'groups'}
          onChange={() => onChange({ visibility: 'groups', groupIds })}
        />
        <span className="text-sm">
          Only these groups
          <span className="block text-xs text-muted">Plus its owner, and administrators.</span>
        </span>
      </label>

      {visibility === 'groups' && (
        <div className="pl-6 space-y-3">
          {available.length === 0 ? (
            <p className="text-xs text-muted">
              You are not in any groups, so you have none to share with. An administrator can put
              you in one under Settings → Groups.
            </p>
          ) : (
            byType(available).map(bucket => (
              <div key={bucket.typeName}>
                <p className="text-xs uppercase tracking-wide text-muted mb-1">{bucket.typeName}</p>
                <div className="flex flex-wrap gap-2">
                  {bucket.groups.map(group => (
                    <button
                      key={group.id}
                      type="button"
                      aria-pressed={selected.has(group.id)}
                      onClick={() => toggle(group.id)}
                      className={`badge badge-lg ${selected.has(group.id) ? 'badge-primary' : 'badge-outline'}`}
                    >
                      {group.name}
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}

          {groupIds.length === 0 && (
            <p className="flex items-start gap-1.5 text-xs text-warning" role="status">
              <LockClosedIcon className="w-4 h-4 shrink-0" />
              With no groups selected, only you and administrators will see this.
            </p>
          )}
        </div>
      )}
    </fieldset>
  )
}

/** The read-only counterpart: a lock and the group names, for a list row. */
export function AccessBadge({
  visibility,
  groups,
  className = '',
}: {
  visibility: ResourceVisibility
  groups: GroupRef[]
  className?: string
}) {
  if (visibility === 'tenant') return null
  return (
    <span className={`inline-flex items-center gap-1 text-xs text-muted ${className}`}>
      <LockClosedIcon className="w-3.5 h-3.5" aria-hidden="true" />
      <span className="sr-only">Restricted to </span>
      {groups.length === 0 ? 'Only you and admins' : groups.map(g => g.name).join(', ')}
    </span>
  )
}
