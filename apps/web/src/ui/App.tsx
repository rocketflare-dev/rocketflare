/**
 * Providers + route table (06 §b, D20, D25).
 *
 * Provider order: ErrorBoundary → QueryClientProvider → AuthProvider → AbilityProvider →
 * BrowserRouter (NavigationBridge, ScrollToTop, routes, ToastContainer). Phase 2 slots
 * `WebSocketProvider` between AbilityProvider and the router.
 *
 * Route tiers: public (`/login`, `/magic-link/sent`, `/invite/:token`); signed-in-without-tenant
 * (`/select-tenant`, `/pending`, `/no-access` — `ProtectedRoute requireTenant={false}`); and the
 * shell (`/*` — `ProtectedRoute`, `Layout` mounted ONCE, nested routes swap beneath it).
 */
import { QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { ErrorBoundary } from '@/ui/components/ErrorBoundary'
import Layout from '@/ui/components/Layout'
import { LoadingIndicator } from '@/ui/components/LoadingIndicator'
import { NotificationsBell } from '@/ui/components/NotificationsBell'
import { OrgSwitcher } from '@/ui/components/OrgSwitcher'
import { PendingInvitationsBanner } from '@/ui/components/PendingInvitationsBanner'
import { ProtectedRoute } from '@/ui/components/ProtectedRoute'
import { AbilityProvider } from '@/ui/components/permissions/AbilityContext'
import { RequireGuard } from '@/ui/components/RequireGuard'
import { RoleBadge } from '@/ui/components/RoleBadge'
import ScrollToTop from '@/ui/components/ScrollToTop'
import { ToastContainer } from '@/ui/components/shared'
import { UserMenu } from '@/ui/components/UserMenu'
import { AuthProvider, useAuth } from '@/ui/hooks/useAuth'
import { NavigationBridge } from '@/ui/lib/navigation'
import { queryClient } from '@/ui/lib/queryClient'
import Home from '@/ui/pages/Home'
import Login from '@/ui/pages/Login'
import NotFound from '@/ui/pages/NotFound'

// Public / no-tenant pages
const MagicLinkSent = lazy(() => import('@/ui/pages/MagicLinkSent'))
const InviteAccept = lazy(() => import('@/ui/pages/InviteAccept'))
const SelectTenant = lazy(() => import('@/ui/pages/SelectTenant'))
const Pending = lazy(() => import('@/ui/pages/Pending'))
const NoAccess = lazy(() => import('@/ui/pages/NoAccess'))
// Shell pages
const Profile = lazy(() => import('@/ui/pages/Profile'))
const Notifications = lazy(() => import('@/ui/pages/Notifications'))
const Activity = lazy(() => import('@/ui/pages/Activity'))
const SettingsLayout = lazy(() => import('@/ui/pages/settings/SettingsLayout'))
const AdminLayout = lazy(() => import('@/ui/pages/admin/AdminLayout'))
const AccessRequests = lazy(() => import('@/ui/pages/admin/AccessRequests'))
const TenantList = lazy(() => import('@/ui/pages/admin/TenantList'))
const TenantDetail = lazy(() => import('@/ui/pages/admin/TenantDetail'))
const UserList = lazy(() => import('@/ui/pages/admin/UserList'))
const UserDetail = lazy(() => import('@/ui/pages/admin/UserDetail'))

// Dev-only TanStack Query devtools. `import.meta.env.DEV` is replaced at build time, so the
// dynamic import (and its chunk) is dropped from production bundles.
const ReactQueryDevtools = import.meta.env.DEV
  ? lazy(() =>
      import('@tanstack/react-query-devtools').then(m => ({ default: m.ReactQueryDevtools }))
    )
  : null

/** Sidebar footer: which org (and as what) the reader is acting in. */
function TenantFooter() {
  const { tenant } = useAuth()
  if (!tenant) return null
  return (
    <div className="flex items-center justify-between gap-2 px-1 py-1 text-xs">
      <span className="truncate text-secondary" title={tenant.name}>
        {tenant.name}
      </span>
      <RoleBadge role={tenant.role} />
    </div>
  )
}

/**
 * Everything that renders inside the app chrome. `Layout` is mounted ONCE for `/*` and these
 * nested routes swap beneath it, so the sidebar and header widgets never remount on navigation.
 */
function ShellRoutes() {
  return (
    <Layout
      headerStart={<OrgSwitcher />}
      headerEnd={
        <>
          <NotificationsBell />
          <UserMenu />
        </>
      }
      sidebarFooter={<TenantFooter />}
    >
      <PendingInvitationsBanner className="mb-6" />
      <Suspense fallback={<LoadingIndicator fullPage />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route
            path="/activity"
            element={
              <RequireGuard guard="admin">
                <Activity />
              </RequireGuard>
            }
          />
          <Route
            path="/settings"
            element={
              <RequireGuard guard="admin">
                <SettingsLayout />
              </RequireGuard>
            }
          />
          <Route
            path="/admin"
            element={
              <RequireGuard guard="globalAdmin">
                <AdminLayout />
              </RequireGuard>
            }
          >
            <Route index element={<Navigate to="/admin/access-requests" replace />} />
            <Route path="access-requests" element={<AccessRequests />} />
            <Route path="tenants" element={<TenantList />} />
            <Route path="tenants/:id" element={<TenantDetail />} />
            <Route path="users" element={<UserList />} />
            <Route path="users/:id" element={<UserDetail />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </Layout>
  )
}

/** Signed in, tenant optional — the holding pages. */
function NoTenantRoute({ children }: { children: React.ReactNode }) {
  return (
    <ProtectedRoute requireTenant={false}>
      <Suspense fallback={<LoadingIndicator size="lg" centered />}>{children}</Suspense>
    </ProtectedRoute>
  )
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/magic-link/sent"
        element={
          <Suspense fallback={<LoadingIndicator size="lg" centered />}>
            <MagicLinkSent />
          </Suspense>
        }
      />
      <Route
        path="/invite/:token"
        element={
          <Suspense fallback={<LoadingIndicator size="lg" centered />}>
            <InviteAccept />
          </Suspense>
        }
      />
      <Route
        path="/select-tenant"
        element={
          <NoTenantRoute>
            <SelectTenant />
          </NoTenantRoute>
        }
      />
      <Route
        path="/pending"
        element={
          <NoTenantRoute>
            <Pending />
          </NoTenantRoute>
        }
      />
      <Route
        path="/no-access"
        element={
          <NoTenantRoute>
            <NoAccess />
          </NoTenantRoute>
        }
      />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <ShellRoutes />
          </ProtectedRoute>
        }
      />
    </Routes>
  )
}

export default function App() {
  return (
    <ErrorBoundary fullPage>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <AbilityProvider>
            {/* Phase 2: <WebSocketProvider> */}
            <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
              <NavigationBridge />
              <ScrollToTop />
              <AppRoutes />
              <ToastContainer />
            </BrowserRouter>
          </AbilityProvider>
        </AuthProvider>
        {ReactQueryDevtools && (
          <Suspense fallback={null}>
            <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
          </Suspense>
        )}
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
