/**
 * Route-table entries for the three-step direct upload (`api.upload`): the presign answers a
 * ticket for `UPLOAD_PUT_URL`, the PUT answers 200, and `confirm` is the test's own answer — the
 * target's (a `files` row, a document). `uploadCalls(fetchMock)` reads back what was sent.
 */
import type { vi } from 'vitest'
import { type FetchLike, jsonResponse, type RouteTable } from './renderWithProviders'

export const UPLOAD_ID = '00000000-0000-4000-8000-0000000000aa'
export const UPLOAD_PUT_URL = 'https://acct.r2.cloudflarestorage.com/bucket/tenants/t/key'

export function uploadRoutes(confirm: RouteTable[string]): RouteTable {
  return {
    'POST /api/uploads': (init: RequestInit | undefined) => {
      const req = JSON.parse(String(init?.body)) as { contentType: string }
      return jsonResponse(
        {
          uploadId: UPLOAD_ID,
          method: 'PUT',
          url: UPLOAD_PUT_URL,
          headers: { 'Content-Type': req.contentType, 'If-None-Match': '*' },
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
        201
      )
    },
    'PUT /bucket/tenants/t/key': new Response(null, { status: 200 }),
    [`POST /api/uploads/${UPLOAD_ID}/confirm`]: confirm,
  }
}

type Mock = ReturnType<typeof vi.fn<FetchLike>>

/** The presign body, the PUT's init, and whether confirm was called. */
export function uploadCalls(fetchMock: Mock) {
  const calls = fetchMock.mock.calls
  const presign = calls.find(([u, i]) => String(u).endsWith('/api/uploads') && i?.method === 'POST')
  const put = calls.find(([u, i]) => String(u) === UPLOAD_PUT_URL && i?.method === 'PUT')
  const confirmed = calls.some(([u]) => String(u).endsWith(`/api/uploads/${UPLOAD_ID}/confirm`))
  return {
    presign: presign
      ? (JSON.parse(String(presign[1]?.body)) as Record<string, unknown>)
      : undefined,
    put: put?.[1],
    confirmed,
  }
}
