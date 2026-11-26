/**
 * The hand-over from Home's composer to Chat: the router state carries the message, the chat page
 * sends it exactly once when the thread is ready, and clears the state so a reload cannot resend.
 */
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { chatHandOverState, readHandOver, useHandOverMessage } from '@/ui/pages/chat/handOver'

describe('chat hand-over', () => {
  it('reads only a non-empty string message from the state', () => {
    expect(readHandOver(chatHandOverState('  Hello  '))).toBe('Hello')
    expect(readHandOver(null)).toBeNull()
    expect(readHandOver({ chatHandOver: 3 })).toBeNull()
    expect(readHandOver(chatHandOverState('   '))).toBeNull()
  })

  it('sends once when ready, and clears the state', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={[{ pathname: '/chat/c1', state: chatHandOverState('Hi') }]}>
        {children}
      </MemoryRouter>
    )
    const send = vi.fn()
    const { result, rerender } = renderHook(
      ({ ready }: { ready: boolean }) => {
        useHandOverMessage('c1', ready, send)
        return useLocation()
      },
      { wrapper, initialProps: { ready: false } }
    )
    expect(send).not.toHaveBeenCalled()
    rerender({ ready: true })
    expect(send).toHaveBeenCalledExactlyOnceWith('Hi')
    expect(result.current.state).toBeNull()
    rerender({ ready: true })
    expect(send).toHaveBeenCalledTimes(1)
  })
})
