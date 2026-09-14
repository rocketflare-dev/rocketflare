/**
 * "Who can see this" as a dialog (D29) — the `AccessPicker` plus a save, shared by the Knowledge
 * list and the dashboard header so the two cannot drift in wording or in what they offer.
 *
 * The caller decides whether to render it at all (`manage Document` / owner, or `manage
 * Dashboard`), and supplies the mutation; this component owns only the draft state.
 */
import type { GroupRef, ResourceVisibility } from '@rocketflare/shared/groups'
import { useEffect, useState } from 'react'
import { AccessPicker } from './AccessPicker'
import { Modal } from './Modal'

export interface VisibilityModalProps {
  open: boolean
  onClose: () => void
  /** What the resource is called, for the title. */
  name: string
  visibility: ResourceVisibility
  groups: GroupRef[]
  /** What this person may share with — every group for an admin, their own for a member. */
  available: GroupRef[]
  tenantName?: string
  isSaving?: boolean
  onSave: (next: { visibility: ResourceVisibility; groupIds: string[] }) => void
}

export function VisibilityModal({
  open,
  onClose,
  name,
  visibility,
  groups,
  available,
  tenantName,
  isSaving = false,
  onSave,
}: VisibilityModalProps) {
  const [draft, setDraft] = useState({ visibility, groupIds: groups.map(g => g.id) })

  // Re-seed each time the dialog opens, or a second row would inherit the first row's draft.
  useEffect(() => {
    if (open) setDraft({ visibility, groupIds: groups.map(g => g.id) })
  }, [open, visibility, groups])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Who can see “${name}”`}
      actions={
        <>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={isSaving}
            onClick={() => onSave(draft)}
          >
            Save
          </button>
        </>
      }
    >
      <AccessPicker
        idPrefix="visibility-modal"
        visibility={draft.visibility}
        groupIds={draft.groupIds}
        available={available}
        tenantName={tenantName}
        onChange={setDraft}
        disabled={isSaving}
      />
    </Modal>
  )
}
