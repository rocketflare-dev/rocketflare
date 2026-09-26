/**
 * Thumbs on an AI answer (D33): the first press POSTs the vote, the other thumb replaces it, and
 * pressing the pressed thumb again withdraws it with a DELETE. The state is drawn from the prop
 * (the parent's one `/api/feedback/mine` query), and `aria-pressed` says which one is set.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FeedbackThumbs } from '@/ui/components/ai/FeedbackThumbs'
import {
  jsonResponse,
  renderWithProviders,
  requestBody,
  stubFetch,
} from './helpers/renderWithProviders'

const MESSAGE = '6b1d9a52-3c4e-4f70-8a91-0b2c3d4e5f60'

const vote = (rating: 1 | -1) => ({
  id: '0f0e0d0c-0b0a-4908-8706-050403020100',
  target: 'message',
  targetId: MESSAGE,
  rating,
  comment: null,
  userId: null,
  traceId: null,
  createdAt: '2026-09-25T10:00:00.000Z',
  updatedAt: '2026-09-25T10:00:00.000Z',
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('FeedbackThumbs', () => {
  it('votes with a POST and withdraws the pressed vote with a DELETE', async () => {
    const fetchMock = stubFetch({
      'POST /api/feedback': () => jsonResponse(vote(-1), 201),
      [`DELETE /api/feedback/message/${MESSAGE}`]: () => new Response(null, { status: 204 }),
    })
    const { rerender } = renderWithProviders(<FeedbackThumbs target="message" targetId={MESSAGE} />)
    const down = screen.getByRole('button', { name: 'Bad answer' })
    expect(down).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(down)
    await waitFor(() =>
      expect(requestBody(fetchMock, 'POST /api/feedback')).toEqual({
        target: 'message',
        targetId: MESSAGE,
        rating: -1,
      })
    )

    rerender(<FeedbackThumbs target="message" targetId={MESSAGE} rating={-1} />)
    expect(screen.getByRole('button', { name: 'Bad answer' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Bad answer' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            init?.method === 'DELETE' && String(input).endsWith(`/api/feedback/message/${MESSAGE}`)
        )
      ).toBe(true)
    )
  })
})
