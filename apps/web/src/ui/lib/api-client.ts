/**
 * API client — the ONE fetch wrapper every query and mutation goes through.
 *
 * - `credentials: 'include'` (cookie session) + JSON content-type
 * - `X-Requested-With: fetch` marks browser-initiated calls. The server's CSRF middleware
 *   decides on `Origin` / `Sec-Fetch-Site` (see src/api/middleware/csrf.ts); the header is
 *   defence in depth and lets a server-side rule single out the SPA if it ever needs to.
 * - Non-2xx → `ApiError`, parsed from the shared error envelope (`@rocketflare/shared/errors`)
 * - Optional zod `schema` validates the response body
 * - `api.upload(target, file)` is the direct upload: presign, `PUT` straight to storage, confirm
 * - `api.postForm(url, formData)` (deprecated) posts multipart to a plugin's own `uploadPaths` route
 * - 401 → the registered unauthorized handler. `AuthProvider` wires it to
 *   `queryClient.clear()` + redirect to `/login?returnUrl=…`.
 */

import { type ApiErrorBody, apiErrorSchema } from '@rocketflare/shared/errors'
import { confirmUploadPath, createUploadResponseSchema } from '@rocketflare/shared/uploads'
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
   * purpose: parse it with the matching `@rocketflare/shared` schema rather than reading fields blind.
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
 * remove it. `AuthProvider` calls this with the redirect-to-login behaviour.
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
  schema?: z.ZodType<T, unknown>
}

/**
 * Turn any non-2xx response into an `ApiErrorBody`. Envelope-shaped bodies pass through
 * verbatim; anything else (HTML from a proxy, empty body) is normalised so callers can always
 * rely on `status` + `error`. Exported for the one fetch that bypasses `request()`: the chat
 * SSE stream (`lib/aguiStream.ts`), whose pre-stream failures use the same envelope.
 */
export async function parseErrorBody(response: Response): Promise<ApiErrorBody> {
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

// `FormData` only for the deprecated `postForm` (a plugin's own multipart route).
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

  // multipart: the browser writes `Content-Type` with its boundary.
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
  upload,
  postForm,
}

const UPLOADS_PATH = '/api/uploads'

type UploadOptions<T> = ApiRequestOptions<T> & { fields?: Record<string, unknown> }

/**
 * Upload a file STRAIGHT to storage — the bytes never pass through the Worker. Three steps:
 * `POST /api/uploads` (every check the target makes, before a byte moves), `PUT` the file to the
 * URL it answers with exactly its headers, then `POST /api/uploads/:id/confirm`, whose answer is
 * the target's (`schema` parses it). A refused `PUT` is an `ApiError` with code
 * `upload_refused`; the server's own errors keep their codes. Errors toast, as for any mutation.
 */
function upload<T>(target: string, file: File, options?: UploadOptions<T>): Promise<T>
/**
 * The 0.45 call: multipart `POST` of `form` to `url`, exactly as {@link postForm}.
 *
 * @deprecated Kept so a plugin UI posting to its own `uploadPaths` route keeps compiling. Move the
 * route to an `uploadTargets` entry and call `api.upload('<id>.<name>', file, { fields })`.
 */
function upload<T>(url: string, form: FormData, options?: ApiRequestOptions<T>): Promise<T>
function upload<T>(
  targetOrUrl: string,
  body: File | FormData,
  options: UploadOptions<T> = {}
): Promise<T> {
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    return postForm<T>(targetOrUrl, body, options)
  }
  return directUpload<T>(targetOrUrl, body as File, options)
}

/**
 * Multipart `POST` of a `FormData` to a plugin's OWN upload route (one under its `uploadPaths`).
 * The same cookie, `X-Requested-With` marker, error envelope and `schema` handling as every other
 * call; no JSON `Content-Type`, so the browser writes the multipart one. Errors toast.
 *
 * @deprecated Kept so a plugin that has not moved to `uploadTargets` keeps its upload page. Declare
 * an `uploadTargets` entry and call `api.upload('<id>.<name>', file, { fields })` instead. It goes
 * in a release that only removes deprecated API.
 */
function postForm<T>(url: string, form: FormData, options?: ApiRequestOptions<T>): Promise<T> {
  return request<T>(url, { method: 'POST', body: form, showErrorToast: true, ...options })
}

async function directUpload<T>(
  target: string,
  file: File,
  options: UploadOptions<T> = {}
): Promise<T> {
  const { fields, ...rest } = options
  const toastOnError = rest.showErrorToast ?? true
  const ticket = await request(UPLOADS_PATH, {
    method: 'POST',
    ...withBody({ target, name: file.name, contentType: file.type, size: file.size, fields }),
    schema: createUploadResponseSchema,
    showErrorToast: toastOnError,
  })
  // No cookie: the URL is its own credential, and R2 is another origin.
  const put = await fetch(ticket.url, {
    method: ticket.method,
    headers: ticket.headers,
    body: file,
    credentials: 'omit',
  }).catch(() => null)
  if (!put?.ok) {
    const error = new ApiError({
      error: 'The file could not be uploaded — try again',
      statusCode: put?.status ?? 0,
      code: 'upload_refused',
    })
    if (toastOnError) showToast(error.message, 'error')
    throw error
  }
  return request<T>(confirmUploadPath(ticket.uploadId), {
    method: 'POST',
    showErrorToast: true,
    ...rest,
  })
}
