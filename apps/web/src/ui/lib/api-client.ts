/**
 * API client — the ONE fetch wrapper every query and mutation goes through.
 *
 * - `credentials: 'include'` (cookie session) + JSON content-type
 * - `X-Requested-With: fetch` marks browser-initiated calls. The server's CSRF middleware
 *   decides on `Origin` / `Sec-Fetch-Site` (see src/api/middleware/csrf.ts); the header is
 *   defence in depth and lets a server-side rule single out the SPA if it ever needs to.
 * - Non-2xx → `ApiError`, parsed from the shared error envelope (`@gmgo/shared/errors`)
 * - Optional zod `schema` validates the response body
 * - `api.upload(url, formData)` posts multipart (no JSON content-type; the browser sets the boundary)
 * - 401 → the registered unauthorized handler (D20). Phase 1 wires it to
 *   `queryClient.clear()` + redirect to `/login?returnUrl=…`.
 */

import { type ApiErrorBody, apiErrorSchema } from '@gmgo/shared/errors'
import type { z } from 'zod'
import { showToast } from '../components/shared/Toast'

// Re-export so hooks that fire a toast around a request need one import
export { showToast }

/** Thrown for every non-2xx response. `body` is the parsed error envelope. */
export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  /**
   * Structured detail from the envelope (zod issues, counts, offending ids…). `unknown` on
   * purpose: parse it with the matching `@gmgo/shared` schema rather than reading fields blind.
   */
  readonly details?: unknown
  readonly body: ApiErrorBody

  constructor(body: ApiErrorBody) {
    super(body.error)
    this.name = 'ApiError'
    this.status = body.statusCode
    this.code = body.code
    this.details = body.details
    this.body = body
  }

  isStatus(status: number): boolean {
    return this.status === status
  }

  isClientError(): boolean {
    return this.status >= 400 && this.status < 500
  }

  isServerError(): boolean {
    return this.status >= 500 && this.status < 600
  }

  isAuthError(): boolean {
    return this.status === 401 || this.status === 403
  }
}

// ---------------------------------------------------------------- 401 hook

export type UnauthorizedHandler = (error: ApiError) => void

let unauthorizedHandler: UnauthorizedHandler | null = null
let unauthorizedPending = false

/**
 * Register the global 401 handler. One handler; the last registration wins. Pass `null` to
 * remove it. Phase 1 calls this from `AuthProvider` with the redirect-to-login behaviour.
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler
}

/**
 * Invoke the 401 handler. A stale session makes every in-flight query fail at once, so calls
 * within the same tick are coalesced into ONE handler invocation. Called by `request()` and
 * by `QueryCache.onError` (lib/queryClient.ts) — both routes are covered, neither double-fires.
 */
export function notifyUnauthorized(error: ApiError): void {
  if (!unauthorizedHandler || unauthorizedPending) return
  unauthorizedPending = true
  queueMicrotask(() => {
    unauthorizedPending = false
    unauthorizedHandler?.(error)
  })
}

// ------------------------------------------------------------------ request

export interface ApiRequestOptions<T = unknown> extends Omit<RequestInit, 'body'> {
  /** Show an error toast on failure (default: false for GET, true for mutations) */
  showErrorToast?: boolean
  /** Show a success toast on success (default: false) */
  showSuccessToast?: boolean
  /** Message for the success toast */
  successMessage?: string
  /** Transform the error message before it is displayed */
  errorMessageTransform?: (message: string) => string
  /**
   * Zod schema to validate the response against; throws a descriptive Error on mismatch.
   * Input is `unknown` so schemas with `.transform()`/`.default()` still infer `T`.
   */
  schema?: z.ZodType<T, z.ZodTypeDef, unknown>
}

/**
 * Turn any non-2xx response into an `ApiErrorBody`. Envelope-shaped bodies pass through
 * verbatim; anything else (HTML from a proxy, empty body) is normalised so callers can always
 * rely on `status` + `error`.
 */
async function parseErrorBody(response: Response): Promise<ApiErrorBody> {
  const fallback: ApiErrorBody = {
    error: response.statusText || `Request failed with status ${response.status}`,
    statusCode: response.status,
  }
  try {
    const json: unknown = await response.json()
    const parsed = apiErrorSchema.safeParse(json)
    if (parsed.success) return { ...parsed.data, statusCode: response.status }
    // Not our envelope but still JSON — keep whatever message it carried
    if (json && typeof json === 'object') {
      const loose = json as { error?: unknown; message?: unknown; code?: unknown }
      const message = [loose.error, loose.message].find(v => typeof v === 'string')
      return {
        ...fallback,
        error: (message as string | undefined) ?? fallback.error,
        code: typeof loose.code === 'string' ? loose.code : undefined,
        details: json,
      }
    }
    return fallback
  } catch {
    return fallback
  }
}

type RequestBody = string | FormData

async function request<T>(
  url: string,
  options: ApiRequestOptions<T> & { body?: RequestBody } = {}
): Promise<T> {
  const {
    showErrorToast = false,
    showSuccessToast = false,
    successMessage,
    errorMessageTransform,
    schema,
    ...fetchOptions
  } = options

  // multipart: let the browser set `Content-Type` with its boundary.
  const isMultipart = typeof FormData !== 'undefined' && fetchOptions.body instanceof FormData
  const response = await fetch(url, {
    credentials: 'include',
    ...fetchOptions,
    headers: {
      ...(isMultipart ? {} : { 'Content-Type': 'application/json' }),
      'X-Requested-With': 'fetch',
      ...fetchOptions.headers,
    },
  })

  if (!response.ok) {
    const body = await parseErrorBody(response)
    const error = new ApiError(
      errorMessageTransform ? { ...body, error: errorMessageTransform(body.error) } : body
    )

    if (error.status === 401) notifyUnauthorized(error)
    if (showErrorToast) showToast(error.message, 'error')

    throw error
  }

  // 204 / empty body
  if (response.status === 204) return undefined as T
  const text = await response.text()
  if (!text) return undefined as T

  let data = JSON.parse(text) as T

  if (schema) {
    const result = schema.safeParse(data)
    if (!result.success) {
      const issues = result.error.issues
        .slice(0, 3)
        .map(issue => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')
      throw new Error(`Response validation failed for ${url}: ${issues}`)
    }
    data = result.data
  }

  if (showSuccessToast && successMessage) showToast(successMessage, 'success')

  return data
}

function withBody(body: unknown): { body?: string } {
  return body !== undefined ? { body: JSON.stringify(body) } : {}
}

/** GET → no error toast by default (queries render their own error state); mutations → toast. */
export const api = {
  get<T>(url: string, options?: ApiRequestOptions<T>): Promise<T> {
    return request<T>(url, { method: 'GET', showErrorToast: false, ...options })
  },
  post<T>(url: string, body?: unknown, options?: ApiRequestOptions<T>): Promise<T> {
    return request<T>(url, { method: 'POST', ...withBody(body), showErrorToast: true, ...options })
  },
  put<T>(url: string, body?: unknown, options?: ApiRequestOptions<T>): Promise<T> {
    return request<T>(url, { method: 'PUT', ...withBody(body), showErrorToast: true, ...options })
  },
  patch<T>(url: string, body?: unknown, options?: ApiRequestOptions<T>): Promise<T> {
    return request<T>(url, {
      method: 'PATCH',
      ...withBody(body),
      showErrorToast: true,
      ...options,
    })
  },
  delete<T>(url: string, body?: unknown, options?: ApiRequestOptions<T>): Promise<T> {
    return request<T>(url, {
      method: 'DELETE',
      ...withBody(body),
      showErrorToast: true,
      ...options,
    })
  },
  /** `POST` a `FormData` body (file uploads, D23). Same envelope/schema handling as the rest. */
  upload<T>(url: string, form: FormData, options?: ApiRequestOptions<T>): Promise<T> {
    return request<T>(url, { method: 'POST', body: form, showErrorToast: true, ...options })
  },
}
