/**
 * What a tool call ANSWERED, rendered as the thing it is rather than as JSON.
 *
 * **Do not write parsers here.** `documentCardsFromToolResult(name, result)` already exists in
 * `@rocketflare/shared/ai/embeddings`, is pure, is documented as serving the agent-run projection,
 * and is the same function the chat stream and the AG-UI projection use — four callers, one
 * implementation. It `safeParse`s, so a retuned knowledge tool degrades to "no cards" rather than
 * to a crash, and it never queries, so it cannot widen tenant scope.
 *
 * Everything else keeps `<details><pre>`, **truncated**: a 200 KB tool result pretty-printed into
 * the DOM is a real hang, not a theoretical one.
 */
import { documentCardsFromToolResult } from '@rocketflare/shared/ai/embeddings'
import { DocumentLink, documentLinkProps } from '@/ui/components/shared'

/** Longest JSON blob rendered into a `<pre>`. Past it the reader gets the head and a byte count. */
export const TOOL_RESULT_MAX_CHARS = 4_000

export function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

export function truncate(text: string, max = TOOL_RESULT_MAX_CHARS): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… ${(text.length - max).toLocaleString()} more characters`
}

/**
 * The documents a knowledge tool's answer named, or null for every other tool.
 *
 * **One line each.** A card strip was right when this was the only thing on the screen; inside a
 * timeline row, four cards bury the stage that comes next — and the reader is here for the shape of
 * the run, not to read a document from inside it. The title still links to the viewer, which is the
 * one thing they might want.
 */
export function ToolResultCards({ name, result }: { name: string; result: unknown }) {
  const cards = documentCardsFromToolResult(name, result)
  if (cards.length === 0) return null
  return (
    <ul className="mt-1.5 space-y-0.5" aria-label="Documents this answer used">
      {cards.map(card => (
        <li key={card.id} className="min-w-0">
          <DocumentLink {...documentLinkProps(card)} />
        </li>
      ))}
    </ul>
  )
}

export function JsonDisclosure({
  summary,
  value,
  className = '',
}: {
  summary: string
  value: unknown
  className?: string
}) {
  return (
    <details className={`mt-1 ${className}`}>
      <summary className="cursor-pointer text-xs text-muted select-none">{summary}</summary>
      <pre className="surface-inset rounded-md p-2 mt-1 text-xs whitespace-pre-wrap break-words max-h-64 overflow-auto">
        {truncate(pretty(value))}
      </pre>
    </details>
  )
}
