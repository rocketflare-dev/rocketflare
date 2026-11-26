/**
 * HTTP client for the app's API. Sends `Authorization: Bearer <key>`, turns the error
 * envelope `{ error, statusCode, code?, details? }` into `CliApiError` (401 → exit 2, 403 → exit 3)
 * and validates success bodies with the zod contract from `@rocketflare/shared`. Network failures are a
 * `CliApiError` with `status: 0` so callers only ever handle one error type.
 */
import { apiErrorSchema } from '@rocketflare/shared/errors'
import { confirmUploadPath, createUploadResponseSchema } from '@rocketflare/shared/uploads'
import type { z } from 'zod'
import { CliError, EXIT_ERROR, EXIT_FORBIDDEN, EXIT_NOT_LOGGED_IN } from './errors'
import { BIN_NAME, VERSION } from './package-info'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface ApiClientOptions {
  serverUrl: string
  apiKey?: string
  fetch?: FetchLike
  timeoutMs?: number
}

export type QueryValue = string | number | boolean | undefined | null

/** The verbs a route can answer, so a plugin command can call a PUT or PATCH route too. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface RequestOptions<T> {
  schema?: z.ZodType<T>
  query?: Record<string, QueryValue>
  body?: unknown
}

export interface ApiResponse<T> {
  status: number
  /** The body exactly as the server sent it — what `--json` prints. */
  raw: unknown
  /** The body validated by `schema` (or `raw` when no schema was given). */
  data: T
}

export class CliApiError extends CliError {
  readonly status: number
  readonly code?: string
  readonly body?: unknown

  constructor(options: {
    status: number
    message: string
    code?: string
    body?: unknown
    hint?: string
    cause?: unknown
  }) {
    super(options.message, {
      exitCode: exitCodeForStatus(options.status),
      hint: options.hint ?? defaultHint(options.status),
      cause: options.cause,
    })
    this.name = 'CliApiError'
    this.status = options.status
    this.code = options.code
    this.body = options.body
  }
}

export function exitCodeForStatus(status: number): number {
  if (status === 401) return EXIT_NOT_LOGGED_IN
  if (status === 403) return EXIT_FORBIDDEN
  return EXIT_ERROR
}

function defaultHint(status: number): string | undefined {
  if (status === 401) return `Run \`${BIN_NAME} login\` to authenticate.`
  if (status === 403) return 'Your role in this tenant does not allow that.'
  return undefined
}

export interface ApiClient {
  readonly serverUrl: string
  request<T = unknown>(
    method: HttpMethod,
    path: string,
    options?: RequestOptions<T>
  ): Promise<ApiResponse<T>>
  get<T = unknown>(path: string, options?: RequestOptions<T>): Promise<T>
  post<T = unknown>(path: string, options?: RequestOptions<T>): Promise<T>
  del<T = unknown>(path: string, options?: RequestOptions<T>): Promise<T>
  /** A file's bytes, for a download route that does not answer JSON. Errors are the usual `CliApiError`. */
  getBytes(path: string): Promise<Uint8Array>
  /**
   * Upload a file STRAIGHT to storage through an upload target (`avatars`, `uploads`,
   * `documents`, or a plugin's `<id>.<name>`): `POST /api/uploads`, `PUT` the bytes to the URL it
   * answers (no API key — the URL is its own credential), then `POST /api/uploads/:id/confirm`,
   * whose answer is the target's and is parsed by `schema`.
   */
  upload<T = unknown>(target: string, file: UploadFile, options?: UploadOptions<T>): Promise<T>
}

export interface UploadFile {
  name: string
  /** `''` lets the target decide (a document's type is resolved from its extension). */
  contentType: string
  bytes: Uint8Array
}

export interface UploadOptions<T> {
  schema?: z.ZodType<T>
  /** The target's own fields — a document's `title`, `source`, `visibility`, `groupIds`. */
  fields?: Record<string, unknown>
}

export function buildUrl(serverUrl: string, path: string, query?: Record<string, QueryValue>) {
  const url = new URL(`${serverUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const serverUrl = options.serverUrl.replace(/\/+$/, '')
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init))
  const timeoutMs = options.timeoutMs ?? 30_000

  async function request<T>(
    method: HttpMethod,
    path: string,
    reqOptions: RequestOptions<T> = {}
  ): Promise<ApiResponse<T>> {
    const url = buildUrl(serverUrl, path, reqOptions.query)
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': `${BIN_NAME}-cli/${VERSION}`,
    }
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`
    if (reqOptions.body !== undefined) headers['Content-Type'] = 'application/json'

    let response: Response
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: reqOptions.body === undefined ? undefined : JSON.stringify(reqOptions.body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (cause) {
      throw new CliApiError({
        status: 0,
        code: 'network_error',
        message: `Could not reach ${serverUrl} (${describeCause(cause)})`,
        hint: 'Is the server running? Check the URL with `--server` or `ROCKETFLARE_URL`.',
        cause,
      })
    }

    const raw = await readBody(response)
    if (!response.ok) throw errorFromResponse(response.status, raw, method, path)
    if (!reqOptions.schema) return { status: response.status, raw, data: raw as T }

    const parsed = reqOptions.schema.safeParse(raw)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const where = issue?.path.length ? ` at ${issue.path.join('.')}` : ''
      throw new CliApiError({
        status: response.status,
        code: 'invalid_response',
        body: raw,
        message: `Unexpected response from ${method} ${path}${where}: ${issue?.message ?? 'invalid'}`,
        hint: 'The server and CLI contracts may be out of sync — update both from the same commit.',
      })
    }
    return { status: response.status, raw, data: parsed.data }
  }

  async function sendRaw(method: 'GET', path: string, init: RequestInit) {
    const url = buildUrl(serverUrl, path)
    let response: Response
    try {
      response = await fetchImpl(url, { ...init, method, signal: AbortSignal.timeout(timeoutMs) })
    } catch (cause) {
      throw new CliApiError({
        status: 0,
        code: 'network_error',
        message: `Could not reach ${serverUrl} (${describeCause(cause)})`,
        hint: 'Is the server running? Check the URL with `--server` or `ROCKETFLARE_URL`.',
        cause,
      })
    }
    if (!response.ok) {
      throw errorFromResponse(response.status, await readBody(response), method, path)
    }
    return response
  }

  return {
    serverUrl,
    request,
    getBytes: async path => {
      const response = await sendRaw('GET', path, { headers: authHeaders(options, '*/*') })
      return new Uint8Array(await response.arrayBuffer())
    },
    upload: async <T>(target: string, file: UploadFile, uploadOptions: UploadOptions<T> = {}) => {
      const ticket = await request('POST', '/api/uploads', {
        body: {
          target,
          name: file.name,
          contentType: file.contentType,
          size: file.bytes.byteLength,
          fields: uploadOptions.fields,
        },
        schema: createUploadResponseSchema,
      })
      let put: Response
      try {
        put = await fetchImpl(ticket.data.url, {
          method: ticket.data.method,
          headers: ticket.data.headers,
          body: new Blob([file.bytes as Uint8Array<ArrayBuffer>]),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (cause) {
        throw new CliApiError({
          status: 0,
          code: 'network_error',
          message: `Could not upload ${file.name} to storage (${describeCause(cause)})`,
          cause,
        })
      }
      if (!put.ok) {
        throw new CliApiError({
          status: put.status,
          code: 'upload_refused',
          body: await readBody(put),
          message: `Storage refused the upload of ${file.name} (HTTP ${put.status})`,
          hint: 'The URL may have expired; run the command again.',
        })
      }
      const confirmed = await request('POST', confirmUploadPath(ticket.data.uploadId), {
        schema: uploadOptions.schema,
      })
      return confirmed.data as T
    },
    get: (path, o) => request('GET', path, o).then(r => r.data),
    post: (path, o) => request('POST', path, o).then(r => r.data),
    del: (path, o) => request('DELETE', path, o).then(r => r.data),
  }
}

function authHeaders(options: ApiClientOptions, accept: string): Record<string, string> {
  return {
    Accept: accept,
    'User-Agent': `${BIN_NAME}-cli/${VERSION}`,
    ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
  }
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined
  const text = await response.text()
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function errorFromResponse(status: number, body: unknown, method: string, path: string) {
  const envelope = apiErrorSchema.safeParse(body)
  if (envelope.success) {
    return new CliApiError({
      status,
      code: envelope.data.code,
      body,
      message: envelope.data.error,
    })
  }
  return new CliApiError({
    status,
    body,
    message: `${method} ${path} failed with HTTP ${status}`,
  })
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const inner = (cause as { cause?: unknown }).cause
    if (inner instanceof Error && 'code' in inner) return String((inner as { code: unknown }).code)
    if (cause.name === 'TimeoutError') return 'timed out'
    return cause.message
  }
  return String(cause)
}
