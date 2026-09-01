/**
 * AI error normalisation (D17): every provider failure becomes one `AiError` with a small, stable
 * `code` the routes/UI branch on, a redacted message (a vendor body can echo the request headers —
 * including the key that was just rejected), and `describeAiError` for the sentence a person sees.
 * `AiNotConfiguredError` is the 503 `ai_not_configured` envelope the resolver throws BEFORE any
 * stream opens.
 */
import type { AiProvider } from '@rocketflare/shared/ai/config'
import { ERROR_CODES } from '@rocketflare/shared/errors'
import { ServiceUnavailableError } from '../../utils/core/errors'

export type AiErrorCode = 'auth' | 'rate_limit' | 'invalid_request' | 'unavailable' | 'unknown'

export class AiError extends Error {
  constructor(
    public readonly code: AiErrorCode,
    public readonly provider: AiProvider,
    message: string,
    public readonly status?: number,
    options?: { cause?: unknown }
  ) {
    super(redactSecrets(message), options)
    this.name = 'AiError'
  }
}

/** 503 `ai_not_configured`: nothing resolves for the tenant (no config row, no platform key). */
export class AiNotConfiguredError extends ServiceUnavailableError {
  constructor(scope: 'chat' | 'embeddings' = 'chat') {
    super(
      scope === 'chat'
        ? 'No AI chat provider is configured. Add one in Settings → AI, or set ANTHROPIC_API_KEY.'
        : 'No embeddings provider is configured. Add one in Settings → AI, bind Workers AI, or set EMBEDDINGS_API_KEY.',
      ERROR_CODES.aiNotConfigured
    )
    this.name = 'AiNotConfiguredError'
  }
}

/** Longest error text any surface shows. Enough for a sentence, not a body. */
const MAX_ERROR_LENGTH = 200

/**
 * Patterns that must never reach a response body or a log line, most specific first. The last is
 * deliberately blunt: any unbroken 32+ char token in an error sentence is far more likely to be a
 * credential than something a reader needed.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:authorization|x-api-key|api[-_]?key|auth[-_]?token)\b\s*[:=]\s*(?:bearer\s+)?\S+/gi,
  /\bBearer\s+\S+/gi,
  /\b(?:sk|fw|gsk|xai|pk)[-_][A-Za-z0-9._-]{8,}/gi,
  /\bAKIA[0-9A-Z]{8,}\b/g,
  /\b[A-Za-z0-9_-]{32,}\b/g,
]

/** Replace anything credential-shaped with a marker. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((out, pattern) => out.replace(pattern, '[redacted]'), text)
}

/** Status → code. `null` status = transport failure. */
export function codeForStatus(status: number | null | undefined): AiErrorCode {
  if (status === null || status === undefined) return 'unavailable'
  if (status === 401 || status === 403) return 'auth'
  if (status === 429 || status === 529) return 'rate_limit'
  if (status === 400 || status === 404 || status === 413 || status === 422) return 'invalid_request'
  if (status >= 500) return 'unavailable'
  return 'unknown'
}

/** Exhausted-account phrases providers are KNOWN to send (Anthropic 400, OpenAI 429). */
const ACCOUNT_EXHAUSTED = [
  /credit balance is too low/i,
  /insufficient_quota/i,
  /exceeded your current quota/i,
]

/** The status carried by an SDK error (`APIError.status`) or a `Response`-shaped failure, else null. */
function statusOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null
  const status = (err as { status?: unknown }).status
  return typeof status === 'number' ? status : null
}

/**
 * Turn whatever a provider/adapter threw into an `AiError`. Idempotent (an `AiError` passes
 * through), never throws itself, never keeps the raw body beyond a redacted, truncated sentence.
 */
export function normalizeAiError(err: unknown, provider: AiProvider): AiError {
  if (err instanceof AiError) return err
  const status = statusOf(err)
  const raw = err instanceof Error ? err.message : String(err)
  if (err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message))) {
    return new AiError(
      'unavailable',
      provider,
      'The request to the AI provider was aborted',
      undefined,
      {
        cause: err,
      }
    )
  }
  if (status !== null && ACCOUNT_EXHAUSTED.some(p => p.test(raw))) {
    return new AiError('auth', provider, 'The AI provider account is out of credit', status, {
      cause: err,
    })
  }
  const code =
    status !== null
      ? codeForStatus(status)
      : /timeout|ECONN|fetch failed|network/i.test(raw)
        ? 'unavailable'
        : 'unknown'
  const safe = redactSecrets(raw).trim()
  const message = safe.length > MAX_ERROR_LENGTH ? `${safe.slice(0, MAX_ERROR_LENGTH)}…` : safe
  return new AiError(
    code,
    provider,
    message || 'The AI provider call failed',
    status ?? undefined,
    {
      cause: err,
    }
  )
}

/** The actionable sentence for a person, derived from the code — never the vendor body. */
export function describeAiError(err: AiError): string {
  if (/out of credit/i.test(err.message)) {
    return 'The AI provider account is out of credit. Top up the account with the provider — the key and model are fine.'
  }
  switch (err.code) {
    case 'auth':
      return 'The AI provider rejected the credentials. Check the API key in Settings → AI.'
    case 'rate_limit':
      return 'The AI provider is rate-limited or overloaded right now. Wait a few seconds and retry.'
    case 'invalid_request':
      return err.status === 404
        ? 'The AI provider does not recognise the configured model. Check the model in Settings → AI.'
        : 'The AI provider rejected the request. This usually means the model id is wrong for this provider.'
    case 'unavailable':
      return 'The AI provider did not answer. Wait a moment and retry.'
    default:
      return err.message || 'The AI provider call failed.'
  }
}
