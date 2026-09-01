import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from '@/ui/components/ErrorBoundary'

function Bomb({ explode }: { explode: boolean }) {
  if (explode) throw new Error('kaboom')
  return <div>all good</div>
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React logs the caught error; keep the test output clean
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <Bomb explode={false} />
      </ErrorBoundary>
    )
    expect(screen.getByText('all good')).toBeInTheDocument()
  })

  it('shows the fallback with a reload button when a child throws', () => {
    const onError = vi.fn()
    render(
      <ErrorBoundary onError={onError}>
        <Bomb explode />
      </ErrorBoundary>
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong')
    expect(screen.getByRole('button', { name: /Reload/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.anything())
  })

  it('resets when resetKeys change', () => {
    const { rerender } = render(
      <ErrorBoundary resetKeys={['/a']}>
        <Bomb explode />
      </ErrorBoundary>
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()

    rerender(
      <ErrorBoundary resetKeys={['/b']}>
        <Bomb explode={false} />
      </ErrorBoundary>
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('all good')).toBeInTheDocument()
  })

  it('uses a custom fallback when provided', () => {
    render(
      <ErrorBoundary fallback={error => <p>custom: {error.message}</p>}>
        <Bomb explode />
      </ErrorBoundary>
    )
    expect(screen.getByText('custom: kaboom')).toBeInTheDocument()
  })
})
