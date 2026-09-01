import { ArrowPathIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
  /** Custom fallback; receives the error and a reset callback */
  fallback?: (error: Error, reset: () => void) => ReactNode
  /** When any of these change, the boundary resets (e.g. `[location.pathname]`) */
  resetKeys?: readonly unknown[]
  /** Called on catch — plug in error reporting here */
  onError?: (error: Error, info: ErrorInfo) => void
  /** Fill the viewport (root) rather than the container (`<main>`) */
  fullPage?: boolean
}

interface ErrorBoundaryState {
  error: Error | null
}

function keysChanged(a: readonly unknown[] = [], b: readonly unknown[] = []) {
  return a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))
}

/**
 * Catches render errors below it and shows a token-styled fallback with a retry. Used at the
 * root (whole-app crash → reload) and around `<main>` in Layout (a page crash keeps the
 * chrome and resets on navigation via `resetKeys`).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info)
    if (!this.props.onError) console.error('[ErrorBoundary]', error, info.componentStack)
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (this.state.error && keysChanged(prevProps.resetKeys, this.props.resetKeys)) {
      this.reset()
    }
  }

  reset = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback) return this.props.fallback(error, this.reset)
    return <ErrorFallback error={error} onReset={this.reset} fullPage={this.props.fullPage} />
  }
}

export function ErrorFallback({
  error,
  onReset,
  fullPage = false,
}: {
  error: Error
  onReset: () => void
  fullPage?: boolean
}) {
  return (
    <div
      role="alert"
      className={`flex items-center justify-center p-6 ${fullPage ? 'min-h-screen main-gradient' : 'min-h-[40vh]'}`}
    >
      <div className="surface-panel max-w-md w-full text-center">
        <ExclamationTriangleIcon className="w-10 h-10 mx-auto mb-3 text-warning" />
        <h2 className="text-lg font-semibold mb-1">Something went wrong</h2>
        <p className="text-sm text-secondary mb-4">
          {import.meta.env.DEV ? error.message : 'An unexpected error occurred.'}
        </p>
        <div className="flex justify-center gap-2">
          <button type="button" className="btn btn-sm btn-ghost" onClick={onReset}>
            Try again
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary gap-1.5"
            onClick={() => window.location.reload()}
          >
            <ArrowPathIcon className="w-4 h-4" />
            Reload
          </button>
        </div>
      </div>
    </div>
  )
}
