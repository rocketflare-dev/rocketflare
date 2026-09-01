import { QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { ErrorBoundary } from '@/ui/components/ErrorBoundary'
import Layout from '@/ui/components/Layout'
import { LoadingIndicator } from '@/ui/components/LoadingIndicator'
import ScrollToTop from '@/ui/components/ScrollToTop'
import { ToastContainer } from '@/ui/components/shared'
import { queryClient } from '@/ui/lib/queryClient'
import Home from '@/ui/pages/Home'
import NotFound from '@/ui/pages/NotFound'

// Dev-only TanStack Query devtools. `import.meta.env.DEV` is replaced at build time, so the
// dynamic import (and its chunk) is dropped from production bundles.
const ReactQueryDevtools = import.meta.env.DEV
  ? lazy(() =>
      import('@tanstack/react-query-devtools').then(m => ({ default: m.ReactQueryDevtools }))
    )
  : null

/**
 * Everything that renders inside the app chrome. `Layout` is mounted ONCE for `/*` and these
 * nested routes swap beneath it, so the sidebar and header widgets never remount on navigation.
 *
 * Phase 1: wrap the shell in `<ProtectedRoute>`; gate sections with `<RequireGuard guard=…>`
 * (see components/RequireGuard.tsx); lazy-load heavy pages with `lazy()` — the `Suspense`
 * below already provides the fallback.
 */
function ShellRoutes() {
  return (
    <Layout>
      <Suspense fallback={<LoadingIndicator fullPage />}>
        <Routes>
          <Route path="/" element={<Home />} />
          {/* Phase 1: /profile, /settings/*, /admin/* (RequireGuard), /select-tenant, /pending */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </Layout>
  )
}

function AppRoutes() {
  return (
    <Routes>
      {/* Phase 1: public routes OUTSIDE the shell — /login, /magic-link/verify, /invite/accept */}
      <Route path="/*" element={<ShellRoutes />} />
    </Routes>
  )
}

/**
 * Provider order (analysis 06 §b / D20):
 *   ErrorBoundary → QueryClientProvider → [AuthProvider → AbilityProvider → WebSocketProvider]
 *   → BrowserRouter → ScrollToTop → routes → ToastContainer.
 * The bracketed providers arrive in Phases 1–2 and slot in exactly where the comment sits.
 */
export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        {/* Phase 1: <AuthProvider> → <AbilityProvider>; Phase 2: <WebSocketProvider> */}
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <ScrollToTop />
          <AppRoutes />
          <ToastContainer />
        </BrowserRouter>
        {ReactQueryDevtools && (
          <Suspense fallback={null}>
            <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
          </Suspense>
        )}
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
