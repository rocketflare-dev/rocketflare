/**
 * Create / rename a dashboard page (D19, D20). Name + description are validated with the same
 * `@rocketflare/shared/analytics` schema the route applies (`FieldError` per field). When `templates`
 * is supplied (create only) a "Start from" select offers each dashboard template as a starting
 * point — the caller resolves the key to its `DashboardConfig` (`getTemplate` from the pure
 * `src/dashboards` registry); renaming never touches `config`.
 */
import {
  ANALYTICS_PAGE_DESCRIPTION_MAX,
  ANALYTICS_PAGE_NAME_MAX,
  createAnalyticsPageRequestSchema,
  type DashboardTemplateSummary,
} from '@rocketflare/shared/analytics'
import { type FormEvent, useEffect, useState } from 'react'
import { FieldError, fieldErrorFor, Modal } from '@/ui/components/shared'

export interface DashboardFormValues {
  name: string
  description: string | null
  /** `undefined` = blank dashboard (create only). */
  templateKey?: string
}

interface DashboardFormModalProps {
  open: boolean
  title: string
  submitText?: string
  initial?: { name: string; description: string | null }
  /** Offer "start from template" (create). Omit when renaming. */
  templates?: DashboardTemplateSummary[]
  isPending?: boolean
  onClose: () => void
  onSubmit: (values: DashboardFormValues) => void
}

type Issue = { path: PropertyKey[]; message: string }

const formSchema = createAnalyticsPageRequestSchema.pick({ name: true, description: true })

export function DashboardFormModal({
  open,
  title,
  submitText = 'Save',
  initial,
  templates,
  isPending = false,
  onClose,
  onSubmit,
}: DashboardFormModalProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [templateKey, setTemplateKey] = useState('')
  const [issues, setIssues] = useState<Issue[] | undefined>()

  // Fresh form each time it opens (the same modal serves create and rename).
  useEffect(() => {
    if (!open) return
    setName(initial?.name ?? '')
    setDescription(initial?.description ?? '')
    setTemplateKey('')
    setIssues(undefined)
  }, [open, initial?.name, initial?.description])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const parsed = formSchema.safeParse({
      name,
      description: description.trim() ? description : null,
    })
    if (!parsed.success) return setIssues(parsed.error.issues)
    setIssues(undefined)
    onSubmit({
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      templateKey: templates && templateKey ? templateKey : undefined,
    })
  }

  return (
    <Modal
      open={open}
      onClose={isPending ? () => {} : onClose}
      title={title}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={isPending}>
            Cancel
          </button>
          <button
            type="submit"
            form="dashboard-form"
            className="btn btn-primary"
            disabled={isPending}
          >
            {isPending && <span className="loading loading-spinner loading-xs" />}
            {submitText}
          </button>
        </>
      }
    >
      <form id="dashboard-form" onSubmit={submit} className="space-y-3" noValidate>
        <div>
          <label htmlFor="dashboard-name" className="label text-sm font-medium">
            Name
          </label>
          <input
            id="dashboard-name"
            className="input w-full"
            value={name}
            maxLength={ANALYTICS_PAGE_NAME_MAX}
            onChange={e => setName(e.target.value)}
            disabled={isPending}
            aria-invalid={fieldErrorFor(issues, 'name') ? true : undefined}
          />
          <FieldError message={fieldErrorFor(issues, 'name')} />
        </div>
        <div>
          <label htmlFor="dashboard-description" className="label text-sm font-medium">
            Description <span className="text-muted font-normal">(optional)</span>
          </label>
          <textarea
            id="dashboard-description"
            className="textarea w-full"
            rows={2}
            value={description}
            maxLength={ANALYTICS_PAGE_DESCRIPTION_MAX}
            onChange={e => setDescription(e.target.value)}
            disabled={isPending}
            aria-invalid={fieldErrorFor(issues, 'description') ? true : undefined}
          />
          <FieldError message={fieldErrorFor(issues, 'description')} />
        </div>
        {templates && (
          <div>
            <label htmlFor="dashboard-template" className="label text-sm font-medium">
              Start from
            </label>
            <select
              id="dashboard-template"
              className="select w-full"
              value={templateKey}
              onChange={e => setTemplateKey(e.target.value)}
              disabled={isPending}
            >
              <option value="">Blank dashboard</option>
              {templates.map(t => (
                <option key={t.key} value={t.key}>
                  Template: {t.name}
                </option>
              ))}
            </select>
            {templateKey && (
              <p className="mt-1 text-xs text-muted">
                {templates.find(t => t.key === templateKey)?.description}
              </p>
            )}
          </div>
        )}
      </form>
    </Modal>
  )
}
