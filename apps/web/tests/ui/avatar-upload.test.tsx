/**
 * Profile → avatar upload (D23): a picked image is POSTed as multipart to `/api/files?scope=avatars`;
 * a wrong type or an oversized file is refused client-side (no request); "Remove" clears the
 * avatar via `PATCH /api/me`.
 */
import { MAX_UPLOAD_BYTES } from '@rocketflare/shared/files'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Profile from '@/ui/pages/Profile'
import {
  IDS,
  makeSession,
  makeUser,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'

const FILE_ID = '99999999-9999-4999-8999-999999999999'

function stubProfileRoutes(user = makeUser(), extra: Record<string, unknown> = {}) {
  return stubFetch({
    '/api/me': { ...user, preferences: {} },
    '/auth/methods': { magicLink: true, providers: [], devLogin: false },
    '/auth/providers': { providers: [] },
    'POST /api/files': {
      id: FILE_ID,
      tenantId: IDS.tenant,
      ownerUserId: IDS.user,
      scope: 'avatars',
      filename: 'me.png',
      contentType: 'image/png',
      sizeBytes: 3,
      url: `/api/files/${FILE_ID}`,
      createdAt: '2025-06-01T00:00:00Z',
    },
    'PATCH /api/me': (init: RequestInit | undefined) => ({
      ...user,
      ...(JSON.parse(String(init?.body)) as object),
    }),
    ...extra,
  })
}

const uploadCall = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.find(
    ([input, init]) => init?.method === 'POST' && String(input).startsWith('/api/files')
  )

describe('Profile → avatar upload', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs the chosen image as multipart to /api/files?scope=avatars', async () => {
    const fetchMock = stubProfileRoutes()
    renderWithProviders(<Profile />, { session: makeSession() })
    const input = (await screen.findByLabelText('Upload photo')) as HTMLInputElement
    expect(input.accept).toBe('image/png,image/jpeg,image/gif,image/webp')

    const file = new File([new Uint8Array([1, 2, 3])], 'me.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(uploadCall(fetchMock)).toBeDefined())
    const [url, init] = uploadCall(fetchMock) as [string, RequestInit]
    expect(url).toBe('/api/files?scope=avatars')
    expect(init.body).toBeInstanceOf(FormData)
    const sent = (init.body as FormData).get('file')
    expect(sent).toBeInstanceOf(File)
    expect((sent as File).name).toBe('me.png')
    // multipart: the browser sets the boundary, so no JSON content-type may be forced
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('refuses a non-image or an oversized file before any request', async () => {
    const fetchMock = stubProfileRoutes()
    renderWithProviders(<Profile />, { session: makeSession() })
    const input = await screen.findByLabelText('Upload photo')

    fireEvent.change(input, {
      target: { files: [new File(['hi'], 'notes.txt', { type: 'text/plain' })] },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(/PNG, JPEG, GIF or WebP/)

    const big = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'big.png', {
      type: 'image/png',
    })
    fireEvent.change(input, { target: { files: [big] } })
    expect(await screen.findByRole('alert')).toHaveTextContent(/5 MB or smaller/)

    expect(uploadCall(fetchMock)).toBeUndefined()
  })

  it('shows Remove only with an avatar and clears it with PATCH /api/me', async () => {
    const fetchMock = stubProfileRoutes(makeUser({ avatarUrl: `/api/files/${FILE_ID}` }))
    renderWithProviders(<Profile />, {
      session: makeSession({ user: makeUser({ avatarUrl: `/api/files/${FILE_ID}` }) }),
    })
    const remove = await screen.findByRole('button', { name: 'Remove' })
    fireEvent.click(remove)
    await waitFor(() =>
      expect(requestBody(fetchMock, 'PATCH /api/me')).toEqual({ avatarUrl: null })
    )
  })

  it('has no Remove button without an avatar', async () => {
    stubProfileRoutes()
    renderWithProviders(<Profile />, { session: makeSession() })
    await screen.findByLabelText('Upload photo')
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
  })
})
