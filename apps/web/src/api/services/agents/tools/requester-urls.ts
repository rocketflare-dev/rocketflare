/**
 * The URLs the REQUESTER wrote — `ToolCtx.requesterUrls`. A tool that fetches the web reads a URL
 * only when it is one of these or one its own search returned, so text arriving from elsewhere (a
 * page, a document, an email, another tool's answer, the model's own output) cannot point it at an
 * address the person never asked for.
 *
 * Where the text comes from is the caller's decision, and the only one that matters:
 * - a chat turn: the conversation's `user` messages (a conversation has one owner) and the new turn;
 * - an agent run: the run's `input`, but only when a person submitted it through
 *   `POST /api/agents/runs` (`agent_runs.input_from_requester`) — never a plugin's or an event's.
 *
 * Each URL is normalised with `new URL()` (fragment dropped), so a tool compares `toString()` of its
 * own parsed URL against the set. Only `http:` / `https:`, at most `REQUESTER_URLS_MAX` of them.
 */

export const REQUESTER_URLS_MAX = 50
const URL_MAX_LENGTH = 2048
const NO_URLS: ReadonlySet<string> = Object.freeze(new Set<string>())

/** `http(s)://` up to whitespace or a closing bracket/quote — the shapes a person pastes. */
const URL_PATTERN = /https?:\/\/[^\s<>"'`()[\]{}]+/gi
/** Punctuation that ends a sentence rather than the URL. */
const TRAILING = /[.,;:!?]+$/

export function normaliseRequesterUrl(raw: string): string | null {
  if (raw.length > URL_MAX_LENGTH) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  url.hash = ''
  return url.toString()
}

function collect(texts: Iterable<string>): ReadonlySet<string> {
  const found = new Set<string>()
  for (const text of texts) {
    for (const match of text.matchAll(URL_PATTERN)) {
      const url = normaliseRequesterUrl(match[0].replace(TRAILING, ''))
      if (url) found.add(url)
      if (found.size >= REQUESTER_URLS_MAX) return Object.freeze(found)
    }
  }
  return found.size === 0 ? NO_URLS : Object.freeze(found)
}

/** URLs in text the requester typed. */
export function requesterUrlsFromTexts(texts: Iterable<string>): ReadonlySet<string> {
  return collect(texts)
}

/** URLs in every string inside a run's validated input (objects and arrays walked, depth-bounded). */
export function requesterUrlsFromInput(input: unknown): ReadonlySet<string> {
  const strings: string[] = []
  const walk = (value: unknown, depth: number) => {
    if (depth > 8 || strings.length > 1000) return
    if (typeof value === 'string') strings.push(value)
    else if (Array.isArray(value)) for (const item of value) walk(item, depth + 1)
    else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) walk(item, depth + 1)
    }
  }
  walk(input, 0)
  return collect(strings)
}

/** A run's requester URLs: from its input only when a person submitted it (`input_from_requester`). */
export function requesterUrlsForRun(
  run: { inputFromRequester: boolean; requestedByUserId: string | null },
  input: unknown
): ReadonlySet<string> {
  return run.inputFromRequester && run.requestedByUserId ? requesterUrlsFromInput(input) : NO_URLS
}

export const noRequesterUrls = (): ReadonlySet<string> => NO_URLS
