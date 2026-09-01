/**
 * Turning a tool's answer into a `tool.end` event payload (D7, D18) — i.e. into the audit trail a
 * person reads in the run drawer when they ask "where did this answer come from?".
 *
 * A tool answers the MODEL with JSON sized for a context window; an event is read by a HUMAN out of
 * a `jsonb` column. Persisting the raw string does neither job: it arrives double-encoded (a wall
 * of `\"`) and a flat character truncation cuts it mid-token, so the trace shows the first hit's
 * opening line and nothing about the passages the answer actually used.
 *
 * So: parse the JSON (the drawer then renders real structure), keep every hit's identity — title,
 * document id, passage number, offset, score — and trim only the bulky prose to a preview, marking
 * what was trimmed. The result is small enough for a row and complete enough to audit.
 */
import { GET_DOCUMENT_TOOL } from './get-document'
import { SEARCH_KNOWLEDGE_TOOL } from './search-knowledge'

/** Prose kept per passage / per document window. Enough to recognise the evidence. */
export const EVENT_PREVIEW_CHARS = 600
/** Cap for a tool whose shape we do not know: its JSON, truncated. */
export const EVENT_FALLBACK_CHARS = 1_500

function preview(text: string): { text: string; truncated?: true } {
  return text.length > EVENT_PREVIEW_CHARS
    ? { text: `${text.slice(0, EVENT_PREVIEW_CHARS)}…`, truncated: true }
    : { text }
}

function parse(resultText: string): unknown {
  try {
    return JSON.parse(resultText)
  } catch {
    return undefined
  }
}

interface SearchShape {
  query?: string
  documents?: Array<{
    documentId?: string
    title?: string
    totalPassages?: number
    matchingPassages?: number
    passages?: Array<{
      rank?: number
      passage?: number
      charOffset?: number | null
      score?: number
      text?: string
    }>
  }>
  [key: string]: unknown
}

interface DocumentShape {
  documentId?: string
  title?: string
  totalChars?: number
  offset?: number
  returnedChars?: number
  hasMore?: boolean
  nextOffset?: number | null
  text?: string
  [key: string]: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/**
 * The `data` for a `tool.end` event: the parsed answer with its prose previewed. Unknown tools fall
 * back to their parsed JSON, or to truncated text when the answer was not JSON at all.
 */
export function summariseToolResult(name: string, resultText: string): unknown {
  const parsed = parse(resultText)
  if (parsed === undefined) {
    return resultText.length > EVENT_FALLBACK_CHARS
      ? `${resultText.slice(0, EVENT_FALLBACK_CHARS)}…`
      : resultText
  }
  if (!isRecord(parsed)) return parsed

  if (name === SEARCH_KNOWLEDGE_TOOL && Array.isArray((parsed as SearchShape).documents)) {
    const search = parsed as SearchShape
    return {
      ...search,
      documents: (search.documents ?? []).map(doc => ({
        ...doc,
        passages: (doc.passages ?? []).map(passage => ({
          ...passage,
          ...(typeof passage.text === 'string' ? preview(passage.text) : {}),
        })),
      })),
    }
  }

  if (name === GET_DOCUMENT_TOOL && typeof (parsed as DocumentShape).text === 'string') {
    const doc = parsed as DocumentShape
    return { ...doc, ...preview(doc.text ?? '') }
  }

  // An unknown tool, or a dead-end answer (`{ error, hint }`): structure is already small.
  const encoded = JSON.stringify(parsed)
  if (encoded.length <= EVENT_FALLBACK_CHARS) return parsed
  return { summary: `${encoded.slice(0, EVENT_FALLBACK_CHARS)}…`, truncated: true }
}
