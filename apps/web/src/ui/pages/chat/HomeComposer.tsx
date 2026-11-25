/**
 * Home's "Ask anything" composer (feature-chat's section in `pages/home-sections.ts`). Enter
 * starts a conversation and opens Chat with the message on its way (`chatHandOverState`); the
 * suggestions are built from the organisation's own newest indexed documents, so they are always
 * questions this workspace can answer. With no chat model the composer is a "Connect a model"
 * card instead — never an input that cannot answer.
 */
import { ArrowUpIcon, SparklesIcon } from '@heroicons/react/24/outline'
import type { HomeDocument } from '@rocketflare/shared/home'
import { type FormEvent, type KeyboardEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { SectionPanelSkeleton } from '@/ui/components/shared'
import { useCreateConversation } from '@/ui/hooks/useChat'
import { useHomeSummary } from '@/ui/hooks/useHome'
import { usePermissions } from '@/ui/hooks/usePermissions'
import { isAiNotConfigured } from '@/ui/lib/aguiStream'
import { settingsTabPath } from '../settings/tabs'
import { chatHandOverState } from './handOver'

const TEMPLATES = [
  (title: string) => `Summarise “${title}”`,
  (title: string) => `Key points from “${title}”`,
  (title: string) => `What should we act on in “${title}”?`,
]

/** Asked when every document title is machine-made (\"Summary 2026-09-17 08:31\"). */
const GENERIC_PROMPT = 'What is in our newest documents?'

const TITLE_MAX = 40

/**
 * A title fit to read inside a prompt, or `null` when it is machine-made: the file extension and
 * separators go, a long one is shortened, and a date with at most one word beside it is skipped.
 */
export function friendlyTitle(raw: string): string | null {
  const title = raw
    .trim()
    .replace(/\.(md|txt|pdf|docx?|html?|csv)$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
  if (!title) return null
  const dateless = title.replace(/\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?/g, '')
  const words = dateless.match(/\p{L}{3,}/gu) ?? []
  if (words.length === 0) return null
  // "Summary 2026-09-17 08:31": a date and one generic word is not a title anybody asks about.
  if (dateless !== title && words.length < 2) return null
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1).trimEnd()}…` : title
}

/**
 * Up to three prompts from the newest indexed documents with a readable title, one template each.
 * Indexed documents with only machine-made titles give one generic prompt instead. Pure.
 */
export function suggestedPrompts(documents: readonly HomeDocument[] | undefined): string[] {
  const indexed = (documents ?? []).filter(d => d.status === 'indexed')
  const titles = [...new Set(indexed.map(d => friendlyTitle(d.title)).filter(t => t !== null))]
  if (titles.length === 0) return indexed.length > 0 ? [GENERIC_PROMPT] : []
  return titles
    .slice(0, TEMPLATES.length)
    .map((title, i) => (TEMPLATES[i] ?? TEMPLATES[0])?.(title) ?? title)
}

export default function HomeComposer() {
  const { data, isLoading } = useHomeSummary()
  const create = useCreateConversation()
  const navigate = useNavigate()
  const [draft, setDraft] = useState('')

  if (isLoading) return <SectionPanelSkeleton rows={1} />
  if (!data?.chat) return null
  if (!data.chat.ready || isAiNotConfigured(create.error)) return <ConnectModel />

  const ask = (message: string) => {
    const content = message.trim()
    if (!content || create.isPending) return
    create.mutate(
      {},
      {
        onSuccess: conversation =>
          navigate(`/chat/${conversation.id}`, { state: chatHandOverState(content) }),
      }
    )
  }
  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    ask(draft)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }
  const suggestions = suggestedPrompts(data.knowledge?.recent)

  const ready = draft.trim().length > 0

  return (
    <section aria-labelledby="home-composer-title" className="surface-panel">
      <h2 id="home-composer-title" className="text-lg font-semibold mb-3">
        Ask anything
      </h2>
      <form onSubmit={submit} className="relative">
        <textarea
          id="home-composer"
          aria-labelledby="home-composer-title"
          rows={3}
          className="textarea w-full text-base leading-7 resize-none field-sizing-content min-h-28 max-h-60 pr-16 pb-14 bg-[color:var(--surface-inset)]"
          placeholder="Ask about your documents, your agents’ work or anything else"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={create.isPending}
        />
        <button
          type="submit"
          className="btn btn-primary btn-circle absolute right-3 bottom-3"
          aria-label="Ask"
          disabled={create.isPending || !ready}
        >
          {create.isPending ? (
            <span className="loading loading-spinner loading-sm" />
          ) : (
            <ArrowUpIcon className="w-5 h-5" />
          )}
        </button>
      </form>
      {suggestions.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted">Try</span>
          <ul className="contents" aria-label="Suggestions">
            {suggestions.map(prompt => (
              <li key={prompt} className="min-w-0 max-w-full">
                <button
                  type="button"
                  className="btn btn-sm btn-outline rounded-full font-normal gap-1.5 max-w-full"
                  onClick={() => ask(prompt)}
                  disabled={create.isPending}
                >
                  <SparklesIcon className="w-4 h-4 shrink-0 text-[color:var(--color-primary)]" />
                  <span className="truncate min-w-0">{prompt}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

function ConnectModel() {
  const { can } = usePermissions()
  const canConfigure = can('manage', 'AiConfig')
  return (
    <section
      aria-label="Connect a model"
      className="surface-panel flex flex-wrap items-center gap-4"
    >
      <SparklesIcon className="w-6 h-6 text-[color:var(--color-primary)] shrink-0" />
      <div className="flex-1 min-w-[14rem]">
        <h2 className="text-base font-semibold">Connect a model</h2>
        <p className="text-sm text-secondary max-w-prose">
          {canConfigure
            ? 'Chat, agents and search answer with a model your organisation chooses. Add one and you can ask anything here.'
            : 'Chat, agents and search need a model. Ask an administrator to add one in Settings → AI.'}
        </p>
      </div>
      {canConfigure && (
        <Link to={settingsTabPath('ai')} className="btn btn-primary btn-sm">
          Connect a model
        </Link>
      )}
    </section>
  )
}
