/**
 * The three-step direct upload, driven through the real app: `POST /api/uploads`, the `PUT` to
 * the URL it answers (in tests, as in `development`, the Worker's own stand-in for R2's presigned
 * URL), then `POST /api/uploads/:id/confirm`. Each step is exported too, for a test about one of
 * them.
 */
import { type CreateUploadResponse, createUploadResponseSchema } from '@rocketflare/shared/uploads'
import type { TestEnv } from '../mocks/bindings'
import { json, request } from './request'

export interface TestUploadFile {
  bytes: BufferSource | string
  name: string
  type: string
}

export function createUploadRequest(
  env: TestEnv,
  headers: Record<string, string>,
  target: string,
  file: TestUploadFile,
  fields?: Record<string, unknown>
): Promise<Response> {
  const size = typeof file.bytes === 'string' ? new Blob([file.bytes]).size : file.bytes.byteLength
  return request(
    '/api/uploads',
    { method: 'POST', headers },
    { env, json: { target, name: file.name, contentType: file.type, size, fields } }
  )
}

/** `PUT` to a ticket's URL with its headers (overridable, to test what the store refuses). */
export function putUpload(
  env: TestEnv,
  ticket: CreateUploadResponse,
  body: BufferSource | string,
  headers: Record<string, string> = ticket.headers
): Promise<Response> {
  const url = new URL(ticket.url)
  return request(
    `${url.pathname}${url.search}`,
    {
      method: 'PUT',
      headers: { ...headers, 'Content-Length': String(new Blob([body]).size) },
      body,
    },
    { env }
  )
}

export function confirmUploadRequest(
  env: TestEnv,
  headers: Record<string, string>,
  uploadId: string
): Promise<Response> {
  return request(`/api/uploads/${uploadId}/confirm`, { method: 'POST', headers }, { env })
}

/**
 * All three steps; answers the CONFIRM response (or the first step's, when it refused). A failed
 * `PUT` throws — a test about the PUT uses the steps.
 */
export async function directUpload(
  env: TestEnv,
  headers: Record<string, string>,
  target: string,
  file: TestUploadFile,
  fields?: Record<string, unknown>
): Promise<Response> {
  const created = await createUploadRequest(env, headers, target, file, fields)
  if (created.status !== 201) return created
  const ticket = createUploadResponseSchema.parse(await json(created))
  const put = await putUpload(env, ticket, file.bytes)
  if (put.status !== 200) throw new Error(`upload PUT failed: ${put.status} ${await put.text()}`)
  return confirmUploadRequest(env, headers, ticket.uploadId)
}

export async function ticketOf(res: Response): Promise<CreateUploadResponse> {
  if (res.status !== 201) throw new Error(`createUpload: ${res.status} ${await res.text()}`)
  return createUploadResponseSchema.parse(await json(res))
}
