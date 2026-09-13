/**
 * The chat inspector (D17) — what is actually going on behind a thread: which model will answer
 * next and which have answered, how much of the history budget the next turn will spend, how close
 * the thread is to trimming and then to a summary, and what it has cost.
 *
 * Admin+ only (`manage AiConfig`, the same gate as Settings → Usage), because it is a cost and
 * configuration surface. The parent decides whether to mount it; this file never renders for a
 * member, and the server refuses anyway.
 *
 * Everything shown is DERIVED server-side from the stored rows, so the panel cannot disagree with
 * the transcript. Two honesty rules it keeps: a cost with unpriced turns in it says so rather than
 * reading as a total, and a turn written before the per-turn model columns existed renders as
 * "unknown" rather than being attributed to whatever answers today.
 */

import { ArrowPathIcon, XMarkIcon } from '@heroicons/react/24/outline'
import type {
  ConversationCompactionStats,
  ConversationContextStats,
  ConversationStats,
} from '@rocketflare/shared/ai/chat'
import { SkeletonRows } from '@/ui/components/shared'
import { useCompactConversation, useConversationStats } from '@/ui/hooks/useChat'
import { showToast } from '@/ui/lib/api-client'

const MICROCENTS_PER_USD = 100_000_000

function formatCost(microcents: number | null): string {
  if (microcents === null) return '—'
  const usd = microcents / MICROCENTS_PER_USD
  if (usd === 0) return '$0.00'
  // Chat turns are cheap enough that two decimals rounds most threads to nothing.
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
}

const n = (value: number) => value.toLocaleString()

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-1">
      <span className="text-xs text-muted shrink-0">{label}</span>
      <span className="text-xs font-mono text-right break-all" title={hint}>
        {value}
      </span>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="px-3 py-2 border-b border-[color:var(--border-subtle)]">
      <h3 className="text-xs font-semibold mb-1">{title}</h3>
      {children}
    </section>
  )
}

/**
 * The one sentence a person actually wants: how far is this thread from forgetting something?
 * There are two distances and they happen in order — the window has to fill before anything is
 * dropped, and enough has to be dropped before a summary is worth a model call.
 */
export function compactionState(
  context: ConversationContextStats,
  compaction: ConversationCompactionStats
): { label: string; detail: string; tone: 'ok' | 'warn' | 'active' } {
  if (context.droppedMessages === 0) {
    return {
      tone: 'ok',
      label: 'Nothing trimmed',
      detail: `${n(context.headroomChars)} characters of history still fit before the oldest turns start dropping out.`,
    }
  }
  if (compaction.pendingMessages === 0) {
    return {
      tone: 'ok',
      label: 'Summarised',
      detail: `${n(compaction.summarisedMessages)} trimmed message(s) are covered by the summary below, which replays as part of the system prompt.`,
    }
  }
  const short = compaction.minChars - compaction.pendingChars
  return short > 0
    ? {
        tone: 'warn',
        label: 'Trimming, not yet summarised',
        detail: `${n(compaction.pendingMessages)} message(s) (${n(compaction.pendingChars)} chars) have dropped out and are not in the summary. The automatic pass waits for ${n(compaction.minChars)} chars — ${n(short)} to go — or summarise now.`,
      }
    : {
        tone: 'active',
        label: 'Summary due',
        detail: `${n(compaction.pendingMessages)} message(s) (${n(compaction.pendingChars)} chars) are past the ${n(compaction.minChars)}-char threshold; a summary job runs on the next turn, or now.`,
      }
}

/**
 * The five disjoint parts of the next turn's prompt, in the order they are sent. Two of them —
 * the system prompt and the tool schemas — go on EVERY turn regardless of what was asked, which is
 * usually the surprise: a short question on a fresh thread is still not a short prompt.
 */
const COMPOSITION_PARTS = [
  {
    key: 'systemPrompt',
    label: 'System prompt',
    hint: 'The `chat` prompt, sent every turn. Override it in Settings → Prompts.',
  },
  {
    key: 'toolSchemas',
    label: 'Tool schemas',
    hint: "The knowledge tools' JSON Schemas, re-sent every turn. CHAT_KNOWLEDGE_TOOLS=false removes them.",
  },
  {
    key: 'summary',
    label: 'Summary',
    hint: 'The rolling summary of the trimmed prefix, replayed as part of the system prompt.',
  },
  { key: 'userMessages', label: 'Your messages', hint: 'Replayed user turns inside the window.' },
  {
    key: 'assistantMessages',
    label: 'Replies',
    hint: 'Replayed assistant turns inside the window.',
  },
] as const satisfies readonly { key: keyof ContextComposition; label: string; hint: string }[]

type ContextComposition = ConversationContextStats['composition']

const PART_COLOURS: Record<keyof ContextComposition, string> = {
  systemPrompt: 'bg-primary',
  toolSchemas: 'bg-secondary',
  summary: 'bg-accent',
  userMessages: 'bg-info',
  assistantMessages: 'bg-success',
}

function share(chars: number, total: number): string {
  if (total === 0) return '0'
  return `${n(chars)} · ${Math.round((chars / total) * 100)}%`
}

/** One bar rather than five numbers: the proportions are the point, the digits are the detail. */
function CompositionBar({
  composition,
  total,
}: {
  composition: ContextComposition
  total: number
}) {
  if (total === 0) return null
  return (
    <div className="flex h-2 w-full overflow-hidden rounded my-1" aria-hidden="true">
      {COMPOSITION_PARTS.map(part => {
        const width = (composition[part.key] / total) * 100
        return width > 0 ? (
          <div
            key={part.key}
            className={PART_COLOURS[part.key]}
            style={{ width: `${width}%` }}
            title={`${part.label}: ${share(composition[part.key], total)}`}
          />
        ) : null
      })}
    </div>
  )
}

function StatsBody({
  stats,
  conversationId,
}: {
  stats: ConversationStats
  conversationId: string
}) {
  const compact = useCompactConversation(conversationId)
  const state = compactionState(stats.context, stats.compaction)
  const contextTokens = Math.round(stats.context.totalChars / stats.context.charsPerToken)
  const tone =
    state.tone === 'warn' ? 'text-warning' : state.tone === 'active' ? 'text-info' : 'text-muted'

  return (
    <div className="overflow-y-auto flex-1">
      <Section title="Answering next">
        {stats.next.ready ? (
          <>
            <Row label="Model" value={stats.next.model ?? '—'} />
            <Row label="Provider" value={stats.next.provider ?? '—'} />
            <Row label="Resolved from" value={stats.next.source} />
            <Row
              label="Tools"
              value={
                stats.next.knowledgeTools.length
                  ? `${stats.next.knowledgeTools.length} · max ${stats.next.maxToolTurns} turns`
                  : 'off'
              }
              hint={stats.next.knowledgeTools.join(', ')}
            />
          </>
        ) : (
          <p className="text-xs text-muted">No chat provider is configured.</p>
        )}
      </Section>

      <Section title="Context for the next turn">
        <Row
          label="History"
          value={`${n(stats.context.windowChars)} / ${n(stats.context.budgetChars)}`}
          hint="Characters of transcript this turn will replay, against CHAT_HISTORY_MAX_CHARS"
        />
        <progress
          className="progress progress-primary h-1 w-full my-1"
          value={Math.min(stats.context.windowChars, stats.context.budgetChars)}
          max={stats.context.budgetChars}
        />
        <Row label="Messages replayed" value={n(stats.context.windowMessages)} />
        <Row
          label="≈ tokens sent"
          value={n(contextTokens)}
          hint={`Estimated at ${stats.context.charsPerToken} characters per token — the kit's assumption everywhere, not the provider's tokeniser`}
        />
      </Section>

      <Section title="What the prompt is made of">
        <CompositionBar composition={stats.context.composition} total={stats.context.totalChars} />
        {COMPOSITION_PARTS.map(part => (
          <Row
            key={part.key}
            label={part.label}
            value={share(stats.context.composition[part.key], stats.context.totalChars)}
            hint={part.hint}
          />
        ))}
      </Section>

      <Section title="Compaction">
        <p className={`text-xs font-medium ${tone}`}>{state.label}</p>
        <p className="text-xs text-muted mt-0.5">{state.detail}</p>
        {stats.compaction.pendingMessages > 0 && (
          <button
            type="button"
            className="btn btn-xs btn-outline mt-2 gap-1"
            disabled={compact.isPending}
            onClick={() =>
              compact.mutate(undefined, {
                onSuccess: r =>
                  showToast(
                    `Summarising ${r.pendingMessages} message(s) — this runs in the background.`,
                    'success'
                  ),
              })
            }
          >
            <ArrowPathIcon className={`w-3 h-3 ${compact.isPending ? 'animate-spin' : ''}`} />
            Summarise now
          </button>
        )}
        {stats.compaction.summary && (
          <details className="mt-2">
            <summary className="text-xs cursor-pointer">
              Summary ({n(stats.compaction.summary.length)} chars)
            </summary>
            <p className="text-xs text-muted mt-1 whitespace-pre-wrap">
              {stats.compaction.summary}
            </p>
          </details>
        )}
      </Section>

      <Section title="This conversation">
        <Row label="Turns" value={`${n(stats.turns.user)} in · ${n(stats.turns.assistant)} out`} />
        <Row label="Tool calls" value={n(stats.turns.toolCalls)} />
        <Row label="Input tokens" value={n(stats.usage.inputTokens)} />
        <Row label="Output tokens" value={n(stats.usage.outputTokens)} />
        <Row
          label="Cache read / write"
          value={`${n(stats.usage.cacheReadTokens ?? 0)} / ${n(stats.usage.cacheWriteTokens ?? 0)}`}
          hint="Anthropic prompt caching; other providers report reads only"
        />
        <Row label="Cost (est.)" value={formatCost(stats.costMicrocents)} />
        {stats.unpricedTurns > 0 && (
          <p className="text-xs text-warning mt-1">
            {n(stats.unpricedTurns)} turn(s) use a model with no entry in the price table, so they
            are not in that figure.
          </p>
        )}
      </Section>

      {stats.byModel.length > 1 && (
        <Section title="By model">
          {stats.byModel.map(group => (
            <Row
              key={`${group.provider}-${group.model}`}
              label={group.model ?? 'unknown'}
              value={`${n(group.turns)} · ${formatCost(group.costMicrocents)}`}
              hint={group.model ? `${group.provider}` : 'Answered before the model was recorded'}
            />
          ))}
        </Section>
      )}
    </div>
  )
}

export function ChatStatsPanel({
  conversationId,
  onClose,
}: {
  conversationId: string
  onClose: () => void
}) {
  const stats = useConversationStats(conversationId, { enabled: true })

  return (
    <aside
      aria-label="Conversation stats"
      className="surface-panel p-0 w-72 shrink-0 hidden lg:flex flex-col overflow-hidden"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-[color:var(--border-subtle)]">
        <h2 className="text-sm font-semibold">Inspector</h2>
        <button
          type="button"
          className="btn btn-ghost btn-xs btn-square"
          onClick={onClose}
          aria-label="Hide stats"
        >
          <XMarkIcon className="w-3.5 h-3.5" />
        </button>
      </div>
      {stats.isLoading ? (
        <SkeletonRows rows={6} className="p-3" />
      ) : stats.data ? (
        <StatsBody stats={stats.data} conversationId={conversationId} />
      ) : (
        <p className="text-xs text-muted p-3">Stats are unavailable for this conversation.</p>
      )}
    </aside>
  )
}
