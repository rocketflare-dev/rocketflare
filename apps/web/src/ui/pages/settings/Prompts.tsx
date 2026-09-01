/**
 * Settings → Prompts (D17): the registry (`GET /api/ai/prompts`) as a list — key, title,
 * description, Overridden/Default badge — and an editor modal: the effective text, `{{variable}}`
 * chips inserted at the cursor, a live character count against `PROMPT_MAX_LENGTH`, Save (`PUT`),
 * Reset to default (`DELETE`, confirmed) and a preview through `interpolatePrompt` with sample
 * values. Members (`read Prompt`) open the editor read-only.
 */

import { DocumentTextIcon } from '@heroicons/react/24/outline'
import {
  interpolatePrompt,
  PROMPT_MAX_LENGTH,
  type PromptWithResolved,
  updatePromptRequestSchema,
} from '@rocketflare/shared/ai/prompts'
import { type FormEvent, useRef, useState } from 'react'
import {
  ConfirmModal,
  EmptyState,
  FieldError,
  fieldErrorFor,
  Modal,
  SectionPanel,
  SkeletonRows,
} from '@/ui/components/shared'
import { useAuth } from '@/ui/hooks/useAuth'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { useClearPrompt, usePrompts, useUpdatePrompt } from '@/ui/hooks/usePrompts'
import { formatDateTime } from '@/ui/lib/format'

export default function PromptsSettings() {
  const { can } = usePermissions()
  const canManage = can('manage', 'Prompt')
  const { data, isLoading, isError } = usePrompts()
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const items = data?.items ?? []
  const selected = items.find(p => p.definition.key === selectedKey) ?? null

  return (
    <SectionPanel
      flush
      title="Prompts"
      description="The system prompts behind each AI feature. Override any of them for this workspace; a reset returns to the built-in default."
    >
      {isLoading ? (
        <div className="px-5 pb-5">
          <SkeletonRows rows={3} />
        </div>
      ) : isError ? (
        <p className="px-5 pb-5 text-sm text-error" role="alert">
          Prompts could not be loaded.
        </p>
      ) : items.length === 0 ? (
        <EmptyState icon={DocumentTextIcon} message="No prompts registered" />
      ) : (
        <ul className="divide-y divide-[color:var(--border-subtle)]">
          {items.map(prompt => (
            <li
              key={prompt.definition.key}
              className="flex items-start justify-between gap-4 px-5 py-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{prompt.definition.title}</span>
                  <code className="text-xs text-muted">{prompt.definition.key}</code>
                  {prompt.isOverridden ? (
                    <span className="badge badge-primary badge-sm">Overridden</span>
                  ) : (
                    <span className="badge badge-ghost badge-sm">Default</span>
                  )}
                </div>
                <p className="text-sm text-secondary mt-0.5">{prompt.definition.description}</p>
                {prompt.override && (
                  <p className="text-xs text-muted mt-0.5">
                    Overridden {formatDateTime(prompt.override.updatedAt)}
                  </p>
                )}
              </div>
              <button
                type="button"
                className="btn btn-sm btn-ghost shrink-0"
                onClick={() => setSelectedKey(prompt.definition.key)}
                aria-label={`${canManage ? 'Edit' : 'View'} ${prompt.definition.title}`}
              >
                {canManage ? 'Edit' : 'View'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <PromptEditorModal
          key={`${selected.definition.key}:${selected.override?.updatedAt.toISOString() ?? 'default'}`}
          prompt={selected}
          canManage={canManage}
          onClose={() => setSelectedKey(null)}
        />
      )}
    </SectionPanel>
  )
}

/** Sample values for the preview; unknown variables show as `<name>` so a typo stays visible. */
function sampleVars(variables: string[], known: Record<string, string>): Record<string, string> {
  return Object.fromEntries(variables.map(v => [v, known[v] ?? `<${v}>`]))
}

function PromptEditorModal({
  prompt,
  canManage,
  onClose,
}: {
  prompt: PromptWithResolved
  canManage: boolean
  onClose: () => void
}) {
  const { definition } = prompt
  const { user, tenant } = useAuth()
  const update = useUpdatePrompt()
  const clear = useClearPrompt()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(prompt.effectiveText)
  const [issues, setIssues] = useState<{ path: PropertyKey[]; message: string }[]>()
  const [preview, setPreview] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)

  const known = {
    appName: 'Your app',
    tenantName: tenant?.name ?? 'Acme',
    userName: user?.name ?? 'Alex',
  }
  const dirty = text !== prompt.effectiveText
  const over = text.length > PROMPT_MAX_LENGTH

  const insertVariable = (name: string) => {
    const token = `{{${name}}}`
    const el = textareaRef.current
    if (!el) {
      setText(t => t + token)
      return
    }
    const start = el.selectionStart ?? text.length
    const end = el.selectionEnd ?? start
    setText(`${text.slice(0, start)}${token}${text.slice(end)}`)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + token.length, start + token.length)
    })
  }

  const save = (e: FormEvent) => {
    e.preventDefault()
    const parsed = updatePromptRequestSchema.safeParse({ text })
    if (!parsed.success) return setIssues(parsed.error.issues)
    setIssues(undefined)
    update.mutate({ key: definition.key, ...parsed.data }, { onSuccess: onClose })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          {definition.title}
          <code className="text-xs text-muted font-normal">{definition.key}</code>
        </span>
      }
      className="max-w-3xl"
      actions={
        canManage ? (
          <>
            {prompt.isOverridden && (
              <button
                type="button"
                className="btn btn-sm btn-ghost mr-auto"
                onClick={() => setConfirmReset(true)}
                disabled={clear.isPending}
              >
                Reset to default
              </button>
            )}
            <button type="button" className="btn btn-sm" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              form="prompt-editor-form"
              className="btn btn-sm btn-primary"
              disabled={!dirty || over || update.isPending}
            >
              {update.isPending ? 'Saving…' : 'Save'}
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        )
      }
    >
      <form id="prompt-editor-form" onSubmit={save} className="space-y-3" noValidate>
        <p className="text-sm text-secondary">{definition.description}</p>

        {definition.variables.length > 0 && (
          <div>
            <p className="text-xs font-medium mb-1">Variables</p>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Variables">
              {definition.variables.map(name => (
                <button
                  key={name}
                  type="button"
                  className="btn btn-xs btn-outline font-mono"
                  onClick={() => insertVariable(name)}
                  disabled={!canManage}
                  title={`Insert {{${name}}} at the cursor`}
                >
                  {`{{${name}}}`}
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <div className="flex items-center justify-between">
            <label htmlFor="prompt-text" className="text-sm font-medium">
              Prompt text
            </label>
            <span
              className={`text-xs tabular-nums ${over ? 'text-error' : 'text-muted'}`}
              aria-live="polite"
            >
              {text.length.toLocaleString()} / {PROMPT_MAX_LENGTH.toLocaleString()}
            </span>
          </div>
          <textarea
            id="prompt-text"
            ref={textareaRef}
            className={`textarea w-full font-mono text-xs leading-relaxed mt-1 ${over ? 'textarea-error' : ''}`}
            rows={14}
            value={text}
            readOnly={!canManage}
            onChange={e => setText(e.target.value)}
            aria-invalid={over || fieldErrorFor(issues, 'text') ? true : undefined}
          />
          <FieldError message={fieldErrorFor(issues, 'text')} />
          {!prompt.isOverridden && !dirty && (
            <p className="text-xs text-muted mt-1">Showing the built-in default.</p>
          )}
        </div>

        <div>
          <button
            type="button"
            className="btn btn-xs btn-ghost"
            aria-expanded={preview}
            aria-controls="prompt-preview"
            onClick={() => setPreview(p => !p)}
          >
            {preview ? 'Hide preview' : 'Preview with sample values'}
          </button>
          {preview && (
            <pre
              id="prompt-preview"
              className="surface-inset rounded-lg p-3 mt-2 text-xs whitespace-pre-wrap max-h-64 overflow-auto"
            >
              {interpolatePrompt(text, sampleVars(definition.variables, known))}
            </pre>
          )}
        </div>
      </form>

      <ConfirmModal
        isOpen={confirmReset}
        title="Reset to default"
        message={`Discard this workspace's override of "${definition.title}" and use the built-in prompt again?`}
        confirmText="Reset"
        confirmButtonClass="btn-warning"
        isLoading={clear.isPending}
        onCancel={() => setConfirmReset(false)}
        onConfirm={() =>
          clear.mutate(definition.key, {
            onSuccess: () => {
              setConfirmReset(false)
              onClose()
            },
          })
        }
      />
    </Modal>
  )
}
